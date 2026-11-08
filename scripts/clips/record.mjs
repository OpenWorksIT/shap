/**
 * Records the how-it-works clips (components/HowItWorks.tsx) from the app itself, so they always
 * match the screens: a fresh set of books is set up, then each screen's main job is done on a
 * phone-sized screen, a few calm steps at a time. A caption above the screen says what each step
 * is (drawn by ffmpeg in a band of its own, so it never covers the app), each tap shows as a
 * ring, typing is unhurried and scrolling is smooth. Every clip becomes a silent, looping MP4 and
 * WebM.
 *
 *   node scripts/clips/record.mjs --app shap   --url http://localhost:8091 --email owner@example.co.za --password …   --out apps/web/public/clips
 *   node scripts/clips/record.mjs --app pocket --url http://localhost:4173                                           --out ../shap-pocket/apps/web/public/clips
 *
 * Shap needs a fresh database with one owner who hasn't done setup yet (npm run create-owner);
 * Shap Pocket a fresh browser profile (the script uses its own). Needs Playwright, and ffmpeg with
 * drawtext. The caption font: --font, or Inter or DejaVu Sans if installed. All names and figures
 * are made up.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const APP = arg('app', 'shap');
const URL0 = arg('url', 'http://localhost:8091').replace(/\/$/, '');
const OUT = resolve(arg('out', 'apps/web/public/clips'));
const ONLY = arg('only', '');
const pocket = APP === 'pocket';
const VIEW = { width: 390, height: 844 };
// The finished clip: 540 wide, the caption band above the screen. HowItWorks.tsx and styles.css
// size the clip by this shape (540 × 1334).
const OUT_W = 540;
const SCREEN_H = Math.round((VIEW.height * OUT_W) / VIEW.width / 2) * 2; // 1168
const BAND_H = 166;
const FONT =
  arg('font', '') ||
  ['/usr/share/fonts/opentype/inter/Inter-SemiBold.otf', '/usr/share/fonts/truetype/inter/Inter-SemiBold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/Library/Fonts/Inter-SemiBold.otf'].find((f) => existsSync(f));
if (!FONT) throw new Error('No caption font found: pass --font /path/to/a-font.ttf');

mkdirSync(OUT, { recursive: true });
const raw = mkdtempSync(join(tmpdir(), 'clips-'));
const browser = await chromium.launch();
// Playwright records at the screen's own size (a bigger size only pads it), scaled up once at the end.
const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, recordVideo: { dir: raw, size: VIEW }, reducedMotion: 'no-preference' });

// Every tap shows as a ring that fades slowly, so the clip shows where to press.
await ctx.addInitScript(() => {
  window.__ring = (x, y) => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:${x - 24}px;top:${y - 24}px;width:48px;height:48px;border-radius:50%;border:3px solid #e8731c;background:rgba(232,115,28,.22);z-index:99999;pointer-events:none;transition:transform .9s ease-out,opacity .9s ease-out`;
    document.body.appendChild(d);
    requestAnimationFrame(() => {
      d.style.transform = 'scale(1.5)';
      d.style.opacity = '0';
    });
    setTimeout(() => d.remove(), 1000);
  };
  addEventListener('pointerdown', (e) => window.__ring(e.clientX, e.clientY), true);
});

const pause = (p, ms = 900) => p.waitForTimeout(ms);
const go = (p, path) => p.goto(pocket ? `${URL0}/#${path}` : `${URL0}${path}`);
/** Glide the thing into the middle of the screen (no jumps). */
const bring = async (p, locator) => {
  await locator.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await pause(p, 700);
};
const tap = async (p, locator, after = 1100) => {
  await bring(p, locator);
  await pause(p, 350);
  await locator.click();
  await pause(p, after);
};
const type = async (p, locator, text) => {
  await bring(p, locator);
  await locator.click();
  await locator.pressSequentially(text, { delay: 85 });
  await pause(p, 500);
};
/** A dropdown's choice, with a ring where it's tapped (the phone's own picker isn't recorded). */
const choose = async (p, locator, label) => {
  await bring(p, locator);
  const box = await locator.boundingBox();
  if (box) await p.evaluate(([x, y]) => window.__ring(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
  await pause(p, 500);
  await locator.selectOption({ label });
  await pause(p, 900);
};
/** Point at something without tapping it. */
const point = async (p, locator) => {
  await bring(p, locator);
  const box = await locator.boundingBox();
  if (box) await p.evaluate(([x, y]) => window.__ring(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
  await pause(p, 900);
};
const glide = async (p, dy) => {
  await p.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), dy);
  await pause(p, 1200);
};

// ---------------------------------------------------------------- set up the books (not recorded)
{
  const p = await ctx.newPage();
  await p.goto(pocket ? `${URL0}/` : `${URL0}/login`);
  if (!pocket) {
    await p.fill('input[type=email]', arg('email', 'owner@example.co.za'));
    await p.fill('input[type=password]', arg('password', ''));
    await p.keyboard.press('Enter');
  }
  await p.evaluate(() => localStorage.setItem('shap.clipsOff', '1'));
  // Already set up (recording one clip again, with --only): straight to the clips.
  const fresh = await p
    .getByRole('button', { name: 'Let’s set up' })
    .waitFor({ timeout: 30_000 })
    .then(() => true, () => false);
  if (fresh) await setUp(p);
  await p.close();
}

async function setUp(p) {
  await p.getByRole('button', { name: 'Let’s set up' }).click();
  await p.getByRole('button', { name: /A company \(Pty\) Ltd/ }).click();
  await p.getByLabel('Registered name').fill('Fictional Sparks (Pty) Ltd');
  await p.locator('label.check', { hasText: 'Registered for VAT' }).locator('input').check();
  await p.getByLabel('VAT number').fill('4740101508');
  await p.getByRole('button', { name: 'Next' }).click();
  await p.getByRole('button', { name: 'Electrician' }).click();
  await p.getByRole('button', { name: 'No thanks' }).click();
  await p.getByRole('button', { name: 'Next' }).click();
  await p.locator('.panel', { hasText: 'employees on a monthly salary' }).getByRole('button', { name: 'Yes', exact: true }).click();
  await p.getByRole('button', { name: 'Yes', exact: true }).nth(1).click();
  await p.getByLabel('PAYE reference').fill('7230767891');
  await p.getByRole('button', { name: 'Yes', exact: true }).nth(2).click();
  await p.getByRole('button', { name: 'No', exact: true }).nth(3).click();
  await p.locator('.panel', { hasText: 'casual labour' }).getByRole('button', { name: 'No', exact: true }).click();
  await p.getByRole('button', { name: 'Next' }).click();
  await p.getByRole('button', { name: 'Next' }).click();
  for (const q of ['Do you charge for your time', 'Do you drive', 'Do suppliers', 'Do clients sometimes', 'Are you moving']) await p.locator('.panel', { hasText: q }).getByRole('button', { name: 'No', exact: true }).click();
  await p.getByRole('button', { name: 'Next' }).click();
  await p.getByRole('button', { name: 'Skip for now' }).click();
  await p.getByLabel('Address').fill('12 Example Street, Gqeberha, 6001');
  await p.getByLabel('Company registration number').fill('2024/123456/07');
  await p.getByRole('button', { name: 'Next' }).click();
  if (pocket) await p.getByRole('button', { name: /Decide later|Next/ }).last().click();
  await p.getByRole('button', { name: 'Next' }).click();
  await p.locator('.terms-accept input').check();
  await p.getByRole('button', { name: 'Accept and open my books' }).click();
  await p.waitForTimeout(3000);
}

// ---------------------------------------------------------------- the clips
// Each clip opens on its screen with its title, then a few steps, each captioned before it
// happens. Keep a caption to two short lines.
const save = (p) => p.getByRole('button', { name: /^Save|^Add client|^Add job|^Create/ }).last();
const CLIPS = {
  clients: {
    title: 'Clients',
    path: '/clients',
    steps: [
      { say: 'Everyone you quote and invoice' },
      { say: 'Tap New client', do: (p) => tap(p, p.getByRole('button', { name: 'New client' })) },
      {
        say: 'Type their name and address',
        do: async (p) => {
          await type(p, p.getByLabel('Name', { exact: true }), 'Fictional Guesthouse');
          await type(p, p.getByLabel('Address'), '3 Marine Drive, Gqeberha');
        },
      },
      { say: 'Their VAT number, if they’re registered', do: (p) => type(p, p.getByLabel('VAT number'), '4123456784') },
      { say: 'Save. They’re ready for every quote and invoice', do: (p) => tap(p, save(p), 1800) },
    ],
  },
  quotes: {
    title: 'Quotes',
    path: '/documents?kind=quote',
    steps: [
      { say: 'What you’ll charge, before the work starts' },
      { say: 'Tap New quote', do: (p) => tap(p, p.getByRole('link', { name: 'New quote' }).or(p.getByRole('button', { name: 'New quote' })).first(), 1500) },
      { say: 'Pick the client', do: (p) => choose(p, p.getByLabel('Client'), 'Fictional Guesthouse') },
      { say: 'Choose how long the quote is valid', do: (p) => tap(p, p.locator('.term-picks').getByRole('button', { name: '14 days' })) },
      {
        say: 'Add what you’re charging for: its price and VAT',
        do: async (p) => {
          await tap(p, p.getByRole('button', { name: 'Install plug point' }));
          await type(p, p.getByLabel(/Unit price/).first(), '450');
          await point(p, p.getByLabel('VAT on this item').first());
        },
      },
      {
        say: 'Save it, and see the PDF before you send it',
        do: async (p) => {
          await tap(p, p.getByRole('button', { name: /^Save/ }).first(), 1800);
          await tap(p, p.getByRole('button', { name: 'Preview' }), 3500);
          await tap(p, p.getByRole('button', { name: 'Close the preview' }), 900);
        },
      },
    ],
  },
  invoices: {
    title: 'Invoices',
    path: '/documents?kind=quote',
    steps: [
      { say: 'An accepted quote becomes the invoice' },
      { say: 'Open the quote', do: (p) => tap(p, p.locator('a[href*="/documents/"]').first(), 1800) },
      { say: 'Turn it into an invoice', do: (p) => tap(p, p.getByRole('button', { name: 'Turn into an invoice' }), 2200) },
      { say: 'Issue it: now it’s in your books', do: (p) => tap(p, p.getByRole('button', { name: /^Issue invoice/ }), 2200) },
      {
        say: 'When the client pays, record the payment',
        do: async (p) => {
          await tap(p, p.getByRole('button', { name: 'Record a payment' }), 1400);
          await tap(p, p.getByRole('button', { name: /^Record|^Save/ }).last(), 2000);
        },
      },
    ],
  },
  costs: {
    title: 'Costs',
    path: '/costs',
    steps: [
      { say: 'Everything the business pays for' },
      { say: 'Tap Add cost', do: (p) => tap(p, p.getByRole('button', { name: 'Add cost' })) },
      {
        say: 'Type the amount and what it was for',
        do: async (p) => {
          await type(p, p.getByLabel('Amount paid'), '1150');
          await type(p, p.getByLabel('Description'), 'Cable and breakers');
        },
      },
      { say: 'Who you paid', do: (p) => type(p, p.getByLabel('Supplier'), 'Fictional Wholesale') },
      { say: 'Choose the VAT on it', do: (p) => point(p, p.getByLabel('VAT on it')) },
      { say: 'Add it to your books', do: (p) => tap(p, p.getByRole('button', { name: 'Add cost' }).last(), 2000) },
    ],
  },
  jobs: {
    title: 'Jobs',
    path: '/jobs',
    steps: [
      { say: 'Each piece of work, from quote to paid' },
      { say: 'Tap New job', do: (p) => tap(p, p.getByRole('button', { name: 'New job' }).or(p.getByRole('link', { name: 'New job' })).first()) },
      {
        say: 'Name it, and pick the client',
        do: async (p) => {
          await type(p, p.getByLabel('Job name'), 'Guesthouse rewire');
          await choose(p, p.getByLabel('Client', { exact: true }), 'Fictional Guesthouse').catch(() => {});
        },
      },
      { say: 'Save. Its quotes, costs and invoices gather here', do: (p) => tap(p, save(p), 2600) },
    ],
  },
  payroll: {
    title: 'Payroll',
    path: '/payroll?tab=people',
    steps: [
      { say: 'Salaries, with PAYE, UIF and SDL worked out' },
      { say: 'Add each employee once', do: (p) => tap(p, p.getByRole('button', { name: 'Add an employee' })) },
      {
        say: 'Their name and monthly salary',
        do: async (p) => {
          await type(p, p.getByLabel('Name', { exact: true }), 'Sipho Dlamini');
          await type(p, p.getByLabel('Monthly salary (before tax)'), '18500');
        },
      },
      { say: 'Save', do: (p) => tap(p, p.getByRole('button', { name: /^Save|^Add/ }).last(), 1600) },
      {
        say: 'Each month, a pay run works out the tax and payslips',
        do: async (p) => {
          await tap(p, p.getByRole('tab', { name: 'Pay runs' }), 1300);
          await tap(p, p.getByRole('button', { name: /^Pay / }).first(), 2800);
        },
      },
    ],
  },
  accounts: {
    title: 'Accounts',
    path: '/accounts',
    steps: [
      { say: 'Worked out from what you capture' },
      { say: 'Profit and loss for the year', do: (p) => pause(p, 1500) },
      { say: 'The balance sheet', do: (p) => tap(p, p.getByRole('tab', { name: 'Balance sheet' }), 2200) },
      { say: 'Your VAT201, box by box', do: (p) => tap(p, p.getByRole('tab', { name: 'VAT201' }), 2200) },
      { say: 'Check them with your accountant before you file' },
    ],
  },
  home: {
    title: 'Home',
    path: '/',
    steps: [
      { say: 'What needs you today' },
      { say: 'What’s owed to you, and what’s due to SARS', do: (p) => pause(p, 1500) },
      { say: 'Further down: what’s running', do: (p) => glide(p, 420) },
      { say: 'Tap anything to open it', do: (p) => pause(p, 1200) },
    ],
  },
  settings: {
    title: 'Settings',
    path: '/settings',
    steps: [
      { say: 'Your business, and how Shap works for it' },
      { say: 'Your business details', do: (p) => pause(p, 1300) },
      { say: 'Switch on only what you use', do: (p) => tap(p, p.getByRole('tab', { name: 'What you use' }), 2000) },
      { say: 'The audit log: every change, and who made it', do: (p) => tap(p, p.getByRole('tab', { name: 'Audit log' }), 2000) },
    ],
  },
  backup: {
    title: 'Backups',
    path: '/backup',
    pocketOnly: true,
    steps: [
      { say: 'Keep a copy of your books' },
      { say: 'Your books live only on this device', do: (p) => pause(p, 1500) },
      { say: 'Save a copy to your own cloud drive, every week', do: (p) => glide(p, 320) },
    ],
  },
};

/** A caption's words in lines of about 27 characters (the band fits two). */
function wrap(text, width = 27) {
  const lines = [''];
  for (const w of text.split(' ')) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length > width) lines.push(w);
    else lines[lines.length - 1] = last ? `${last} ${w}` : w;
  }
  return lines;
}

/** The caption band: one pair of lines per step, each fading in when its step starts. */
function captionFilter(name, captions, length) {
  const parts = [`fps=15,scale=${OUT_W}:${SCREEN_H}:flags=lanczos,pad=${OUT_W}:${SCREEN_H + BAND_H}:0:${BAND_H}:color=0x1f2b33`];
  captions.forEach((c, i) => {
    const a = c.at.toFixed(2);
    const b = (i + 1 < captions.length ? captions[i + 1].at : length + 5).toFixed(2);
    const lines = wrap(c.text);
    if (lines.length > 2) throw new Error(`${name}: “${c.text}” is too long for the caption band`);
    const top = join(raw, `${name}-${i}-top.txt`);
    const main = join(raw, `${name}-${i}-main.txt`);
    writeFileSync(top, c.top);
    writeFileSync(main, lines.join('\n'));
    const when = `enable='between(t,${a},${b})':alpha='min(1,(t-${a})/0.45)'`;
    parts.push(`drawtext=fontfile=${FONT}:textfile=${top}:fontsize=22:fontcolor=0xf08a3c:x=28:y=30:${when}`);
    parts.push(`drawtext=fontfile=${FONT}:textfile=${main}:fontsize=31:line_spacing=8:fontcolor=white:x=28:y=68:${when}`);
  });
  return parts.join(',');
}

// Every caption fits the band (checked before anything is recorded).
for (const [name, c] of Object.entries(CLIPS)) for (const s of c.steps) if (wrap(s.say).length > 2) throw new Error(`${name}: “${s.say}” is too long for the caption band (two lines of about 27 characters)`);

// Data first (clients before quotes, quotes before invoices).
for (const name of ['clients', 'quotes', 'invoices', 'costs', 'jobs', 'payroll', 'accounts', 'home', 'settings', 'backup']) {
  if (ONLY && !ONLY.split(',').includes(name)) continue;
  const clip = CLIPS[name];
  if (clip.pocketOnly && !pocket) continue;
  const p = await ctx.newPage();
  const born = Date.now();
  // Open on the clip's own screen before the clip starts, so it doesn't begin with a page change.
  await go(p, clip.path);
  await p.waitForTimeout(2500);
  const start = Date.now();
  const captions = [];
  let ok = true;
  try {
    const of = clip.steps.length - 1;
    for (const [i, s] of clip.steps.entries()) {
      captions.push({ at: (Date.now() - start) / 1000, top: i === 0 ? `How it works · ${clip.title}` : `Step ${i} of ${of}`, text: s.say });
      // Time to read the caption before anything moves.
      await pause(p, i === 0 ? 2600 : 1500);
      if (s.do) await s.do(p);
      await pause(p, 700);
    }
    await pause(p, 1800);
  } catch (err) {
    console.error(`${name}: ${err.message.split('\n')[0]}`);
    ok = false;
  }
  const length = (Date.now() - start) / 1000;
  const v = p.video();
  await p.close();
  if (!ok) continue;
  // Waits until the recording is fully written.
  const video = join(raw, `${name}.webm`);
  await v.saveAs(video);
  const out = join(OUT, `${name}.mp4`);
  const cut = ['-y', '-loglevel', 'error', '-ss', String((start - born) / 1000), '-i', video, '-t', String(Math.min(length, 60)), '-vf', captionFilter(name, captions, length), '-an'];
  // MP4 (H.264 High 3.1, named so in HowItWorks.tsx) for most; WebM (VP9) for browsers without H.264.
  execFileSync('ffmpeg', [...cut, '-c:v', 'libx264', '-preset', 'slow', '-crf', '32', '-profile:v', 'high', '-level:v', '3.1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
  execFileSync('ffmpeg', [...cut, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '44', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', out.replace(/\.mp4$/, '.webm')]);
  console.log(`${name}: ${length.toFixed(1)} s, ${captions.length} captions → ${out}`);
}
await ctx.close();
await browser.close();
rmSync(raw, { recursive: true, force: true });
