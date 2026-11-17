/**
 * Linking a business's own Shap to its accountant's Shap Accountant (docs/ACCOUNTANT.md, "A client
 * on its own Shap"). The business's owner makes a link in their own Shap (Settings → People who sign in →
 * Your accountant), choosing what the practice may do there; someone in the practice pastes it into
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
/** How long someone from the practice is then in the client's books: no longer, however busy (a working day). */
export const LINK_SESSION_HOURS = 8;

/**
 * The client's Shap's routes for the practice's server, and the one its people's browsers open:
 * these alone are answered without a session (and without the screen's version header).
 */
export const LINK_PATHS: readonly string[] = ['/api/link/redeem', '/api/link/sign-in', '/api/link/enter', '/api/link/health', '/api/link/person-off', '/api/link/unlink'];

/** A name another server sends (a practice's, one of its people's): one line, without characters that hide or reorder text. */
export function plainName(s: string): string {
  return s
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What stays the client's owner's in their own Shap, whatever they let the practice do: said to the owner, and to the practice. */
export const staysOwners = (whose: 'your' | 'their'): string =>
  `${whose} settings (VAT, PAYE and turnover tax among them) and the chart of accounts, the people who sign in, closing and reopening months and VAT periods, the year end, tax estimates and provisional tax paid, dividends and profit shares, approving the statements, and backups`;
export const LINK_STAYS_OWNERS = staysOwners('your');

/** What a practice may do in a linked client's own Shap, as the client's owner chooses it. */
export const LINK_LEVEL_WORDS: Record<Level, { title: string; hint: string }> = {
  compile: {
    title: 'Read the books and compile the statements',
    hint: 'As your accountant in Shap: they see all of your books (the audit log too), and can download and print what’s in them; they compile your financial statements (filling in the statements’ details and the small business corporation answer as they do), and change nothing else. They can’t approve the statements: that’s for whoever signs them for the business.',
  },
  books: {
    title: 'Write up the books, and compile the statements',
    hint: `As staff with every task ticked but closing and reopening months: they capture and change invoices, quotes, costs, payroll, journals, the bank and the rest; issue invoices and quotes and email them, in your business’s name; and compile your statements. What stays yours: ${LINK_STAYS_OWNERS}.`,
  },
};

/** Who opens a linked client, as the practice gives it (Practice → Who opens it): never as the client's owner there. */
export const LINKED_LEVEL_WORDS: Record<Level, string> = {
  books: 'Writes up the books, as staff in their own Shap (and opens them to compile)',
  compile: 'Reads them and compiles the statements, as their accountant in their own Shap (read only)',
};

/** What the practice is told someone does in a linked client's books (Practice → Who opens it). */
export const WHO_OPENS_LINKED = `Their books are on their own Shap, and they choose what your practice may do there. Someone who writes them up there does it as staff with every task but closing and reopening months; what stays the client owner’s: ${staysOwners('their')}. Someone given them to compile reads them and compiles the statements there, as their accountant. Each opens them in a new tab, under their own name in the client’s audit log, for ${LINK_SESSION_HOURS} hours at most each time. Approving the statements is the client’s own decision, in their own Shap.`;

/**
 * Writing up a linked client's books: every task staff can be given, but the practice's own and
 * closing and reopening months (books.lock: the client's owner keeps that unless they do it).
 */
export const LINKED_BOOKS_TASKS: readonly Task[] = withNeeds(TASK_KEYS.filter((t) => !t.startsWith('practice.') && t !== 'books.lock'));

/**
 * Someone's own name, as a compiler's report names them: a linked client's Shap shows the practice's
 * person as "Name (Practice)" (server links.ts), and the practice goes in a field of its own.
 */
export function ownName(user: { name: string; fromPractice?: string | null }): string {
  const tail = user.fromPractice ? ` (${user.fromPractice})` : '';
  return tail && user.name.endsWith(tail) ? user.name.slice(0, -tail.length) : user.name;
}

/**
 * The compiler's details a compile form starts from: what's saved; but someone from a linked
 * practice whose saved details are another practice's (the client's last accountant) starts from
 * their own name and practice, and nothing of the other's, so nobody signs as someone else.
 */
export function compilerDefaults<C extends { name: string; practice: string; qualification: string; body: string; number: string }>(saved: C, user: { name: string; fromPractice?: string | null }): C {
  if (user.fromPractice && saved.practice && saved.practice !== user.fromPractice) return { ...saved, name: ownName(user), practice: user.fromPractice, qualification: '', body: '', number: '' };
  return { ...saved, name: saved.name || ownName(user), practice: saved.practice || user.fromPractice || '' };
}

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

/**
 * What the client's owner is told before making a link: how the practice comes in, what goes to the
 * practice's Shap and what doesn't (the keys healthForLink sends, server lib/practice.ts), and
 * what's theirs. Each is a point of its own on the screen.
 */
export const LINK_WHAT_GOES: readonly string[] = [
  `Your accountant’s practice opens your books on this server, from its own Shap Accountant, as you choose here. Each time, its Shap asks this one for a sign-in for one of its people that works once; they’re then in your books for ${LINK_SESSION_HOURS} hours at most. Who it is, and when, is shown here and in your audit log; their IP address and browser are kept with it, as for anyone who signs in.`,
  'They sign in at their practice, not here. Where this Shap requires two-factor sign-in, they must have it on at their practice.',
  'Within what you let them do, they work as you would: see, download and print what’s in your books, and, writing them up, send what Shap sends in your business’s name.',
  'Their Shap is sent your business’s name and what you let them do; and, when your practice links and whenever it runs the checks, what Shap’s checks find in your books (which can name your customers and suppliers), where your statements stand, how far your books are closed, and what the returns coming up are worked out from: the kind of business, VAT registration and category, the year-end month, turnover tax, whether you employ people, public benefit organisation approval, and the days dividends were paid lately. Nothing else of your books goes, and nothing goes to OpenWorks IT because of it.',
  'Unlink whenever you like: nobody from the practice opens your books after that. What their Shap was already sent stays on the practice’s server.',
  'Give the link only to your accountant, as you would a password: whoever uses it first is linked. Once they’ve linked, check the practice’s name here, and unlink if it isn’t theirs.',
  'What they do in your books is between you and them, as is checking it. Linking gives them nothing with SARS, the Department of Employment and Labour or CIPC, and Shap files nothing.',
];
