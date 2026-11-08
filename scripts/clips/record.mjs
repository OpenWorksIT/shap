/**
 * Records the how-it-works clips (components/HowItWorks.tsx) from the app itself, so they always
 * match the screens: a fresh set of books is set up, then each screen's main job is done on a
 * phone-sized screen, with each tap shown. Every clip becomes a short, silent, looping MP4 and WebM.
 *
 *   node scripts/clips/record.mjs --app shap   --url http://localhost:8091 --email owner@example.co.za --password …   --out apps/web/public/clips
 *   node scripts/clips/record.mjs --app pocket --url http://localhost:4173                                           --out ../shap-pocket/apps/web/public/clips
 *
 * Shap needs a fresh database with one owner who hasn't done setup yet (npm run create-owner);
 * Shap Pocket a fresh browser profile (the script uses its own). Needs Playwright and ffmpeg.
 * All names and figures are made up.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

mkdirSync(OUT, { recursive: true });
const raw = mkdtempSync(join(tmpdir(), 'clips-'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, recordVideo: { dir: raw, size: VIEW }, reducedMotion: 'no-preference' });

// Every tap shows as a ring, so the clip shows where to press.
await ctx.addInitScript(() => {
  addEventListener(
    'pointerdown',
    (e) => {
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;left:${e.clientX - 22}px;top:${e.clientY - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid #e8731c;background:rgba(232,115,28,.25);z-index:99999;pointer-events:none;transition:transform .5s ease-out,opacity .5s ease-out`;
      document.body.appendChild(d);
      requestAnimationFrame(() => {
        d.style.transform = 'scale(1.6)';
        d.style.opacity = '0';
      });
      setTimeout(() => d.remove(), 700);
    },
    true,
  );
});

const pause = (p, ms = 700) => p.waitForTimeout(ms);
const go = (p, path) => p.goto(pocket ? `${URL0}/#${path}` : `${URL0}${path}`);
const type = async (p, locator, text) => {
  await locator.click();
  await locator.pressSequentially(text, { delay: 45 });
};
const tap = async (p, locator, ms = 650) => {
  await locator.scrollIntoViewIfNeeded();
  await pause(p, 250);
  await locator.click();
  await pause(p, ms);
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
const CLIPS = {
  async clients(p) {
    await go(p, '/clients');
    await pause(p, 1200);
    await tap(p, p.getByRole('button', { name: 'New client' }));
    await type(p, p.getByLabel('Name', { exact: true }), 'Fictional Guesthouse');
    await type(p, p.getByLabel('Address'), '3 Marine Drive, Gqeberha');
    await type(p, p.getByLabel('VAT number'), '4123456784');
    await tap(p, p.getByRole('button', { name: /^Save|Add client/ }).last(), 1500);
  },
  async quotes(p) {
    await go(p, '/documents?kind=quote');
    await pause(p, 1000);
    await tap(p, p.getByRole('link', { name: 'New quote' }).or(p.getByRole('button', { name: 'New quote' })).first(), 1200);
    await p.getByLabel('Client').selectOption({ label: 'Fictional Guesthouse' });
    await pause(p);
    await tap(p, p.getByRole('button', { name: 'Install plug point' }));
    await type(p, p.getByLabel(/Unit price/).first(), '450');
    await tap(p, p.getByRole('button', { name: 'Call-out fee' }));
    await type(p, p.getByLabel(/Unit price/).nth(1), '550');
    await p.getByLabel('VAT on this item').first().scrollIntoViewIfNeeded();
    await pause(p, 900);
    await tap(p, p.getByRole('button', { name: /^Save/ }).first(), 1800);
    await tap(p, p.getByRole('button', { name: 'Preview' }), 2600);
    await tap(p, p.getByRole('button', { name: 'Zoom in' }), 1400);
    await tap(p, p.getByRole('button', { name: 'Close the preview' }), 800);
  },
  async invoices(p) {
    await go(p, '/documents?kind=quote');
    await pause(p, 1000);
    await tap(p, p.locator('a[href*="/documents/"]').first(), 1500);
    await tap(p, p.getByRole('button', { name: 'Turn into an invoice' }), 2000);
    await tap(p, p.getByRole('button', { name: /^Issue invoice/ }), 1800);
    await tap(p, p.getByRole('button', { name: 'Record a payment' }), 1000);
    await tap(p, p.getByRole('button', { name: /^Record|^Save/ }).last(), 1800);
  },
  async costs(p) {
    await go(p, '/costs');
    await pause(p, 1000);
    await tap(p, p.getByRole('button', { name: 'Add cost' }), 900);
    await type(p, p.getByLabel('Amount paid'), '1150');
    await type(p, p.getByLabel('Description'), 'Cable and breakers');
    await type(p, p.getByLabel('Supplier'), 'Fictional Electrical Wholesale');
    await p.getByLabel('VAT on it').scrollIntoViewIfNeeded();
    await pause(p, 1200);
    await tap(p, p.getByRole('button', { name: 'Add cost' }).last(), 1800);
  },
  async jobs(p) {
    await go(p, '/jobs');
    await pause(p, 1000);
    await tap(p, p.getByRole('button', { name: 'New job' }).or(p.getByRole('link', { name: 'New job' })).first(), 900);
    await type(p, p.getByLabel('Job name'), 'Guesthouse rewire');
    await p.getByLabel('Client', { exact: true }).selectOption({ label: 'Fictional Guesthouse' }).catch(() => {});
    await pause(p);
    await tap(p, p.getByRole('button', { name: /^Save|^Add job|^Create/ }).last(), 2000);
  },
  async payroll(p) {
    await go(p, '/payroll?tab=people');
    await pause(p, 1000);
    await tap(p, p.getByRole('button', { name: 'Add an employee' }), 900);
    await type(p, p.getByLabel('Name', { exact: true }), 'Sipho Dlamini');
    await type(p, p.getByLabel('Monthly salary (before tax)'), '18500');
    await tap(p, p.getByRole('button', { name: /^Save|^Add/ }).last(), 1500);
    await tap(p, p.getByRole('tab', { name: 'Pay runs' }), 1000);
    await tap(p, p.getByRole('button', { name: /^Pay / }).first(), 2500);
  },
  async accounts(p) {
    await go(p, '/accounts');
    await pause(p, 1600);
    for (const t of ['Balance sheet', 'VAT201']) await tap(p, p.getByRole('tab', { name: t }), 1800);
  },
  async home(p) {
    await go(p, '/');
    await pause(p, 1500);
    await p.mouse.wheel(0, 500);
    await pause(p, 1500);
    await p.mouse.wheel(0, 500);
    await pause(p, 1500);
  },
  async settings(p) {
    await go(p, '/settings');
    await pause(p, 1500);
    for (const t of ['What you use', 'Audit log']) await tap(p, p.getByRole('tab', { name: t }), 1800);
  },
  async backup(p) {
    if (!pocket) return false;
    await go(p, '/backup');
    await pause(p, 2500);
    await p.mouse.wheel(0, 400);
    await pause(p, 1500);
  },
};

// Data first (clients before quotes, quotes before invoices).
for (const name of ['clients', 'quotes', 'invoices', 'costs', 'jobs', 'payroll', 'accounts', 'home', 'settings', 'backup']) {
  if (ONLY && !ONLY.split(',').includes(name)) continue;
  const p = await ctx.newPage();
  const born = Date.now();
  await p.goto(pocket ? `${URL0}/#/` : `${URL0}/`);
  await p.waitForTimeout(1500);
  const start = Date.now();
  let ok = true;
  try {
    ok = (await CLIPS[name](p)) !== false;
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
  const cut = ['-y', '-loglevel', 'error', '-ss', String((start - born) / 1000), '-i', video, '-t', String(Math.min(length, 20)), '-vf', 'scale=360:-2,fps=24', '-an'];
  // MP4 (H.264) for Safari and iPhones; WebM (VP9) for browsers without H.264.
  execFileSync('ffmpeg', [...cut, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
  execFileSync('ffmpeg', [...cut, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', out.replace(/\.mp4$/, '.webm')]);
  console.log(`${name}: ${length.toFixed(1)} s → ${out}`);
}
await ctx.close();
await browser.close();
rmSync(raw, { recursive: true, force: true });
