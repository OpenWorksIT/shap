/**
 * How the app talks: casual (South African, "Howzit", "lekker") or formal, chosen in the
 * first-run questions and in Settings. Only greetings, confirmations and a few friendly lines
 * change; labels, figures and anything on a client's PDF stay plain.
 */
export type Tone = 'casual' | 'formal';
let tone: Tone = 'casual';
export const setTone = (t: Tone | undefined) => void (tone = t === 'formal' ? 'formal' : 'casual');
export const getTone = () => tone;

const CHEERS = ['Lekker', 'Sharp', 'Shap', 'Nice one', 'Sorted'];

/** A confirmation in the app's voice: "Saved" becomes "Lekker! Saved" when casual. */
export function flavour(text: string): string {
  if (tone === 'formal' || !text || text.length > 70 || /[?]$/.test(text)) return text;
  const pick = CHEERS[[...text].reduce((s, c) => s + c.charCodeAt(0), 0) % CHEERS.length];
  return `${pick}! ${text}`;
}

/**
 * When something fails that the app didn't expect (not a refusal the books explained): no detail,
 * nothing promised, and not "try again", which could make a second of something. The error itself
 * goes in Feedback's trail (console.error), so a bug report carries it.
 */
export const UNEXPECTED = 'That didn’t work. Please let us know: tap Feedback, then Bug found.';

/** The greeting at the top of Home. */
export function greeting(now = new Date()): string {
  if (tone === 'casual') return 'Howzit';
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Friendly lines, both ways. */
export function say(key: keyof typeof LINES): string {
  return LINES[key][tone];
}
const LINES = {
  allPaid: { casual: 'All paid up. Lekker!', formal: 'All paid up' },
  nothingNeeded: { casual: 'Nothing needs you right now. Shap!', formal: 'Nothing needs your attention' },
  addSub: { casual: 'Capture it while it’s fresh: snap the slip.', formal: 'Record it now, with a photo of the slip.' },
  welcomeBack: { casual: 'Welcome back, boet.', formal: 'Welcome back.' },
  setupDone: { casual: 'You’re all set. Let’s go!', formal: 'Your books are ready.' },
} as const;
