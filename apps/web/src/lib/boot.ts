/**
 * The loading screen while the books open (drawn in index.html before any script runs).
 *
 * Opening takes a moment on a phone: Postgres starts inside the app and reads the books from
 * storage, and the very first time it unpacks a new set of books too. A blank screen for that
 * long looks frozen, so this shows what's happening, in words and with a bar that keeps moving:
 * each step of opening (engine.worker.ts reports them) has its own stretch of the bar, and the bar
 * creeps on within a step, slowing as it nears the end of it, so it never sits still.
 */

export type BootStage = 'template' | 'open' | 'migrate' | 'app';

/** Where each step's stretch of the bar runs, first time and every other time. */
const RANGES: Record<'first' | 'usual', Record<BootStage | 'shell', [number, number]>> = {
  first: { shell: [0, 12], template: [12, 45], open: [45, 70], migrate: [70, 90], app: [90, 97] },
  usual: { shell: [0, 25], template: [25, 30], open: [30, 75], migrate: [75, 90], app: [90, 97] },
};

/** What it says while each step runs (a new line every couple of seconds on a long one). */
const WORDS: Record<'first' | 'usual', Record<BootStage | 'shell' | 'done', string[]>> = {
  first: {
    shell: ['Howzit! Getting things ready…'],
    template: ['Unpacking a brand-new set of books…', 'Laying out the ledger, nice and neat…'],
    open: ['Making space for your books on the phone…', 'Setting up the database, hang tight…'],
    migrate: ['Putting in the chart of accounts…', 'Learning the SARS rules (shame, there are a lot)…', 'Sorting out VAT, PAYE and the rest…'],
    app: ['Sharpening the pencils…', 'Nearly there, just now-now…'],
    done: ['Lekker! Let’s go.'],
  },
  usual: {
    shell: ['Howzit! Opening your books…'],
    template: ['Opening your books…'],
    open: ['Fetching the books off the shelf…', 'Dusting off the ledger…'],
    migrate: ['Checking the sums still add up…'],
    app: ['Counting the rands…', 'Sharp-sharp, almost there…'],
    done: ['Ready!'],
  },
};

let kind: 'first' | 'usual' = 'usual';
let stage: BootStage | 'shell' = 'shell';
let shown = 0;
let words = 0;
let wordsAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let finished = false;

const el = () => document.getElementById('boot');

function draw(pct: number, text?: string) {
  const b = el();
  if (!b) return;
  const fill = b.querySelector<HTMLElement>('.fill');
  const pctEl = b.querySelector<HTMLElement>('.pct');
  const what = b.querySelector<HTMLElement>('.what');
  if (fill) fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${Math.floor(pct)}%`;
  b.setAttribute('aria-valuenow', String(Math.floor(pct)));
  if (text != null && what && what.textContent !== text) what.textContent = text;
}

function tick() {
  if (finished) return;
  const [from, to] = RANGES[kind][stage];
  // Creep toward the end of this step's stretch, more slowly the closer it gets.
  shown = Math.max(shown, from);
  shown += (to - 0.5 - shown) * 0.06;
  const lines = WORDS[kind][stage];
  if (Date.now() - wordsAt > 2200 && lines.length > 1) {
    words = (words + 1) % lines.length;
    wordsAt = Date.now();
  }
  draw(shown, lines[Math.min(words, lines.length - 1)]);
}

/** Takes over from index.html's first few ticks. */
export function startBoot() {
  if (!el() || timer) return;
  const early = (window as { __bootTick?: ReturnType<typeof setInterval> }).__bootTick;
  if (early) clearInterval(early);
  const now = Number.parseFloat(el()!.querySelector<HTMLElement>('.fill')?.style.width ?? '0');
  shown = Number.isFinite(now) ? now : 0;
  wordsAt = Date.now();
  timer = setInterval(tick, 100);
}

/** The engine started a step of opening the books (`first`: these are new books). */
export function bootStage(next: BootStage, first?: boolean) {
  if (finished) return;
  if (first) kind = 'first';
  stage = next;
  words = 0;
  wordsAt = Date.now();
  tick();
}

/** Shown at least this long (from the page starting), so it reads as a screen, not a flicker. */
const AT_LEAST_MS = 700;

/** The first screen is ready: fill the bar and fade the loading screen away. */
export function bootDone() {
  if (finished) return;
  finished = true;
  if (timer) clearInterval(timer);
  const b = el();
  if (!b) return;
  draw(100, WORDS[kind].done[0]);
  const wait = Math.max(180, AT_LEAST_MS - performance.now());
  setTimeout(() => {
    b.classList.add('done');
    setTimeout(() => b.remove(), 300);
  }, wait);
}
