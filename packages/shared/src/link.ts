/**
 * Linking a business's own Shap to its accountant's Shap Accountant (docs/ACCOUNTANT.md, "A client
 * on its own Shap"). The business's owner makes a link in their own Shap (Settings → People → Your
 * accountant), choosing what the practice may do there; someone in the practice pastes it into
 * Shap Accountant. The two servers then talk to each other, and only for this: the practice's
 * people open the client's books on the client's own server, in a new tab, each time with a sign-in
 * that works once, for a minute; and the practice's list shows what the client's Shap's checks find.
 * The client unlinks whenever they like; the practice can too.
 */
import { TASK_KEYS, withNeeds, type Task } from './access.js';
import type { Level } from './practice.js';

/** The servers' own conversation, should it ever change (each says which it speaks). */
export const LINK_API = 1;
/** How long a link works before the practice uses it, and a sign-in once made. */
export const LINK_DAYS = 7;
export const LINK_SIGN_IN_SECONDS = 60;

/** What a practice may do in a linked client's own Shap, as the client's owner chooses it. */
export const LINK_LEVEL_WORDS: Record<Level, { title: string; hint: string }> = {
  compile: {
    title: 'Read the books and compile the statements',
    hint: 'As your accountant in Shap: they see everything, compile your financial statements, and change nothing else.',
  },
  books: {
    title: 'Write up the books, and compile the statements',
    hint: 'They capture and change invoices, costs, payroll, journals, the bank and the rest, as staff with every task ticked but closing and reopening months, and compile your statements. What stays yours: your settings, the people who sign in, the year end, tax estimates, dividends, approving the statements, backups.',
  },
};

/**
 * Writing up a linked client's books: every task staff can be given, but the practice's own and
 * closing and reopening months (books.lock: the client's owner keeps that unless they do it).
 */
export const LINKED_BOOKS_TASKS: readonly Task[] = withNeeds(TASK_KEYS.filter((t) => !t.startsWith('practice.') && t !== 'books.lock'));

/** The link the client's owner gives their accountant: their Shap's address, and the code after the #. */
export function linkText(publicUrl: string, code: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/link#${code}`;
}

/** The client's Shap's address and the code, from a link pasted in (or null if it isn't one). */
export function readLink(text: string): { base: string; code: string } | null {
  const m = /^\s*(https?:\/\/[^\s/#?]+(?::\d+)?)(?:\/[^\s#?]*)?\/link#([A-Za-z0-9_-]{20,100})\s*$/.exec(text);
  if (!m) return null;
  try {
    const u = new URL(m[1]!);
    if (u.username || u.password) return null;
    return { base: u.origin, code: m[2]! };
  } catch {
    return null;
  }
}

/** What the client's owner is told before making a link: what goes to the practice's Shap, and what doesn't. */
export const LINK_WHAT_GOES =
  'Your accountant’s practice opens your books from its own Shap Accountant, on this server, as you choose here; each time, who it is goes in your audit log, and they sign in for that time only. Their Shap is sent your business’s name, what you let them do, and, when they run the checks, what Shap’s checks find in your books (which can name your customers and suppliers), the returns coming up and where your statements stand. Your books stay here: nothing else goes, and OpenWorks never gets any of it. Unlink whenever you like, and they can’t open your books again. What they do in your books is between you and them, as is checking it.';
