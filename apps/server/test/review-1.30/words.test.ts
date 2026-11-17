/**
 * The five reviews of 1.30.0 (CPDAUDIT.md): the words of a linked client, as its owner reads them
 * before linking, and as the practice and its people read them after. They say what the practice
 * can do in the owner's books and what stays the owner's, what goes to the practice's Shap (what
 * healthForLink sends, no more and no less), how long someone from the practice is in, who
 * approves, and where things are. Each test fails on the wording the reviews were of.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilerDefaults, LINK_LEVEL_WORDS, LINK_SESSION_HOURS, LINK_STAYS_OWNERS, LINK_WHAT_GOES, LINKED_LEVEL_WORDS, ownName, WHO_OPENS_LINKED } from '@shap/shared';
import { LinkError } from '../../src/lib/link-call.js';
import { healthForLink, type ClientHealth } from '../../src/lib/practice.js';
import { linkWords } from '../../src/modules/practice.js';

const ROOT = join(import.meta.dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const goes = LINK_WHAT_GOES.join(' ');

describe('what the owner is told before linking (words 1, 2, 7, 11; security 4; SARS 6)', () => {
  it('how long the practice’s people are in, and that it’s as the owner could', () => {
    expect(goes).not.toMatch(/they sign in for that time only/);
    expect(goes).toContain(`they’re then in your books for ${LINK_SESSION_HOURS} hours at most`);
    expect(goes).toMatch(/see, download and print what’s in your books, and, writing them up, send what Shap sends in your business’s name/);
    // What's so: their practice's Shap says whether they have two-factor on; the IP address and browser are kept, not shown.
    expect(goes).toMatch(/Where this Shap requires two-factor sign-in, they must have it on at their practice/);
    expect(goes).toMatch(/their IP address and browser are kept with it/);
    expect(goes).not.toMatch(/shown here and in your audit log, with their IP address/);
    // Within what the owner lets them do, not all the owner could.
    expect(goes).toMatch(/Within what you let them do, they work as you would/);
    expect(goes).not.toMatch(/they do as you could/);
    expect(LINK_LEVEL_WORDS.compile.hint).toMatch(/\(the audit log too\)/);
  });

  it('what goes to the practice’s Shap is what healthForLink sends, and when', () => {
    expect(goes).not.toMatch(/Your books stay here: nothing else goes/);
    expect(goes).toMatch(/when your practice links and whenever it runs the checks/);
    // Each key the client's Shap sends, and the words that name it.
    const named: Record<string, RegExp> = {
      at: /whenever it runs the checks/,
      company: /your business’s name/,
      setupDone: /what Shap’s checks find/,
      vatRegistered: /VAT registration/,
      audit: /what Shap’s checks find in your books \(which can name your customers and suppliers\)/,
      statements: /where your statements stand/,
      lockedThrough: /how far your books are closed/,
      deadlineInputs: /the kind of business, VAT registration and category, the year-end month, turnover tax, whether you employ people, public benefit organisation approval, and the days dividends were paid lately/,
    };
    const h: ClientHealth = { at: '2026-11-17T08:00:00.000Z', company: 'Made-up', setupDone: true, vatRegistered: false, audit: { fail: 0, warn: 0, items: [] }, statements: null, lockedThrough: null, pocket: null, deadlineInputs: null };
    for (const k of Object.keys(healthForLink(h))) expect(goes, k).toMatch(named[k]!);
    expect(Object.keys(healthForLink(h)).sort()).toEqual(Object.keys(named).sort());
  });

  it('what happens on unlinking, giving the link, and SARS', () => {
    // Stays there: Shap gives the practice no way to delete it, so nothing says it can.
    expect(goes).toMatch(/What their Shap was already sent stays on the practice’s server/);
    expect(read('docs/ACCOUNTANT.md')).not.toMatch(/practice's to keep or delete/);
    expect(goes).toMatch(/Give the link only to your accountant, as you would a password: whoever uses it first is linked\. Once they’ve linked, check the practice’s name here, and unlink if it isn’t theirs/);
    expect(goes).toMatch(/Linking gives them nothing with SARS, the Department of Employment and Labour or CIPC, and Shap files nothing/);
    expect(goes).toMatch(/nothing goes to OpenWorks IT because of it/);
    expect(goes).not.toMatch(/OpenWorks never gets any of it/);
  });
});

describe('what each level lets the practice do, and what stays the owner’s (words 2, 10; SARS 2, 4; IFRS 6)', () => {
  it('compiling: downloads, the statements’ details and the small business corporation answer, never approving', () => {
    expect(LINK_LEVEL_WORDS.compile.hint).toMatch(/can download and print what’s in them/);
    expect(LINK_LEVEL_WORDS.compile.hint).toMatch(/filling in the statements’ details and the small business corporation answer/);
    expect(LINK_LEVEL_WORDS.compile.hint).toMatch(/They can’t approve the statements/);
  });

  it('writing up: sending in the business’s name, and one list of what stays the owner’s, used everywhere', () => {
    expect(LINK_LEVEL_WORDS.books.hint).toMatch(/issue invoices and quotes and email them, in your business’s name/);
    for (const kept of ['chart of accounts', 'closing and reopening months and VAT periods', 'tax estimates and provisional tax paid', 'dividends and profit shares', 'approving the statements', 'backups', 'the people who sign in', 'the year end'])
      expect(LINK_STAYS_OWNERS, kept).toContain(kept);
    expect(LINK_LEVEL_WORDS.books.hint).toContain(LINK_STAYS_OWNERS);
    expect(WHO_OPENS_LINKED).toContain(LINK_STAYS_OWNERS.replace(/^your/, 'their'));
    expect(read('docs/ACCOUNTANT.md').replace(/\s+/g, ' ')).toContain('closing and reopening months and VAT periods, the year end, tax estimates and provisional tax paid, dividends and profit shares');
  });
});

describe('what the practice reads (words 3, 5, 8, 12; IFRS 2, 4, 5)', () => {
  const page = read('apps/web/src/pages/Practice.tsx');

  it('who opens a linked client: as staff or their accountant, never as their owner', () => {
    for (const w of Object.values(LINKED_LEVEL_WORDS)) expect(w).not.toMatch(/owner/);
    expect(page).toMatch(/\(client\.linked \? LINKED_LEVEL_WORDS : LEVEL_WORDS\)\.books/);
    expect(page).toMatch(/<option value="books" disabled=\{client\.linked\?\.level === 'compile'\}>/);
    expect(WHO_OPENS_LINKED).toContain(`for ${LINK_SESSION_HOURS} hours at most each time`);
    expect(WHO_OPENS_LINKED).toMatch(/Approving the statements is the client’s own decision, in their own Shap/);
  });

  it('their Shap’s own words aren’t shown: what its codes mean is, in the practice’s words', () => {
    expect(linkWords(new LinkError('Their Shap refused (400).', 400, 'bad_request'))).toBe('Their Shap refused (400).');
    expect(linkWords(new LinkError('x', 401, 'link_gone'))).toMatch(/^Their Shap no longer knows this link: they unlinked your practice there \(or their books there were put back from before it\)/);
    expect(linkWords(new LinkError('x', 403, 'link_mfa'))).toMatch(/two-factor/);
    expect(read('apps/server/src/lib/link-call.ts')).not.toMatch(/typeof json\.error === 'string' \? json\.error/);
    expect(read('apps/server/src/lib/link-call.ts')).not.toMatch(/\$\{err\.code \?\? 'no answer'\}/);
  });

  it('the checks are shown as their Shap sent them, and a stale answer is said', () => {
    expect(page).toMatch(/Their Shap’s checks ran \$\{formatDate\(dayOf\(h\.at\)\)\}, and are shown as their Shap sent them\./);
    expect(page).toMatch(/Their Shap couldn’t be reached, or its answer read, since: this is from before\./);
    expect(page).not.toMatch(/open them, or run the checks\.' : 'Shap’s checks haven’t run/);
  });

  it('unlinking and access changes say when someone may still be signed in there', () => {
    expect(page).toMatch(/your people may still be signed in there until their sign-in ends \(\$\{LINK_SESSION_HOURS\} hours at most\)/);
    expect(page).toMatch(/may still be in their books until their sign-in there ends/);
    expect(read('apps/web/src/components/People.tsx')).toMatch(/may still be in its books until their sign-in there ends/);
    expect(read('docs/ACCOUNTANT.md')).not.toMatch(/takes that person out at once/);
  });

  it('a practice’s person in the client’s Shap is told who approves, and compiles in their own name', () => {
    const fs = read('apps/web/src/pages/FinancialStatements.tsx');
    expect(fs).toMatch(/user\.fromPractice\s*\?\s*` Your practice compiles them here \(in Shap Accountant, open these books to compile\); then the \$\{s\?\.governing\.many \?\? 'directors'\} approve them, signed here by the business’s owner/);
    expect(fs).toMatch(/useState\(compilerDefaults\(compiler, user\)\)/);
    // Reopening is the owner's: anyone else is told so.
    expect(fs).toMatch(/isOwner \? 'Reopen them and send them to your accountant again\.' : 'The business’s owner reopens them; then they’re compiled again\.'/);
    const me = { name: 'Made-up Person (Made-up Practice Inc)', fromPractice: 'Made-up Practice Inc' };
    const blank = { name: '', practice: '', qualification: '', body: '', number: '' };
    expect(compilerDefaults(blank, me)).toMatchObject({ name: 'Made-up Person', practice: 'Made-up Practice Inc' });
    // The client's last accountant's details: not theirs to sign under.
    const theirs = { name: 'Earlier Accountant', practice: 'Earlier Practice CC', qualification: 'CA(SA)', body: 'SAICA', number: '99999' };
    expect(compilerDefaults(theirs, me)).toEqual({ name: 'Made-up Person', practice: 'Made-up Practice Inc', qualification: '', body: '', number: '' });
    // Their own practice's saved details, or someone not from a practice: as saved.
    expect(compilerDefaults({ ...theirs, practice: 'Made-up Practice Inc' }, me)).toEqual({ ...theirs, practice: 'Made-up Practice Inc' });
    expect(compilerDefaults(theirs, { name: 'Accountant', fromPractice: null })).toEqual(theirs);
    expect(ownName({ name: 'Made-up Person (Made-up Practice Inc)', fromPractice: 'Made-up Practice Inc' })).toBe('Made-up Person');
    expect(ownName({ name: 'Made-up Person', fromPractice: null })).toBe('Made-up Person');
    expect(fs).toMatch(/Settings → Lists → Chart of accounts, which is the owner’s/);
  });
});

describe('the client’s screens (words 6, 12)', () => {
  it('names the tab as it is: People who sign in', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(join(ROOT, d))) {
        const p = join(d, f);
        if (f === 'node_modules' || f === 'dist') continue;
        if (statSync(join(ROOT, p)).isDirectory()) walk(p);
        else if (/\.(ts|tsx|md|sql)$/.test(f)) files.push(p);
      }
    };
    for (const d of ['apps/server/src', 'apps/server/migrations', 'apps/web/src', 'packages/shared/src', 'docs']) walk(d);
    files.push('CHANGELOG.md');
    for (const f of files) expect(read(f), f).not.toMatch(/Settings → People → /);
  });

  it('the panel: who’s been taken out, when they last signed in, and how to change what they may do', () => {
    const panel = read('apps/web/src/components/YourAccountant.tsx');
    expect(panel).toMatch(/\$\{p\.active \? '' : ' \(taken out\)'\}/);
    expect(panel).toMatch(/last signed in \$\{day\(p\.lastLoginAt\)\}/);
    expect(panel).not.toMatch(/last in your books/);
    expect(panel).toMatch(/To change what they may do, unlink and make a new link\./);
    expect(panel).toMatch(/Stop this link working\?/);
  });

  it('the bar at the top, a sign-in not used, and one that no longer works', () => {
    const shell = read('apps/web/src/components/Shell.tsx');
    expect(shell).toMatch(/doing what they let your practice do here, for \{LINK_SESSION_HOURS\} hours at most/);
    expect(shell).toMatch(/Someone is already signed in to this Shap in this browser, so the sign-in from Shap Accountant wasn’t used/);
    expect(read('apps/web/src/pages/Login.tsx')).toMatch(/or your practice no longer opens these books \(unlinked, or your access changed\)/);
  });
});
