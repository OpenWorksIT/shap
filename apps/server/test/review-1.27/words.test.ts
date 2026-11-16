/**
 * The words-on-screen and liability review of Shap 1.27.0 (CPDAUDIT.md section 7): what the
 * practice's screens, errors and docs say matches what Shap does, and limits OpenWorks' liability.
 * Each failed before its fix.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURES, LEVEL_WORDS, PRACTICE_CAUTION, PRACTICE_NOTE, PRACTICE_TERMS_TICK, UNEXPECTED_IN_A_CLIENT } from '@shap/shared';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const page = read('../../../web/src/pages/Practice.tsx');
const server = read('../../src/modules/practice.ts');
const banner = read('../../../web/src/components/ClientBanner.tsx');
const doc = read('../../../../docs/ACCOUNTANT.md');
const changelog = read('../../../../CHANGELOG.md');
const entry = changelog.slice(changelog.indexOf('## 1.27.0'), changelog.indexOf('## 1.26.1'));

describe('the practice’s words', () => {
  it('marks clients’ and people’s names private, so a feedback screenshot never shows them (1)', () => {
    // Every heading, label or drawer title that shows a name sits in a data-private element.
    expect(page).toMatch(/<h3[^>]*data-private[^>]*>\s*\{c\.name\}/);
    expect(page).toMatch(/title=\{<span data-private>Who opens \{client\.name\}<\/span>\}/);
    expect(page).toMatch(/<div key=\{p\.id\} data-private>\s*<Field label=\{p\.name\}>/);
  });

  it('claims only what Shap does, in the docs and the changelog (1, 3, 5, 13, 14)', () => {
    for (const text of [doc, entry]) {
      expect(text).not.toMatch(/every check Shap has|Postgres itself|all of Shap's screens|no AI reads|come next|Nothing about a client goes to any outside address/);
    }
    expect(doc).toMatch(/Shap uses no AI service on anyone's books/);
    expect(entry).toMatch(/database login can't create databases/);
    expect(entry).toMatch(/nothing is emailed from/);
  });

  it('says what each way in gives (2)', () => {
    expect(LEVEL_WORDS.books).toMatch(/owner/);
    expect(LEVEL_WORDS.compile).toMatch(/accountant/);
    expect(LEVEL_WORDS.compile).toMatch(/read only/);
    expect(page).toMatch(/LEVEL_WORDS/);
    expect(page).toMatch(/records the client’s approval of the financial statements/);
  });

  it('puts the note beside the list, naming every profession OpenWorks isn’t (4)', () => {
    expect(PRACTICE_NOTE).toMatch(/not accountants, tax practitioners or auditors/);
    expect(PRACTICE_NOTE).toMatch(/not every check or return/);
    expect(PRACTICE_NOTE).toMatch(/not advice/);
    // Under the heading, before the list.
    expect(page.indexOf('{PRACTICE_NOTE}')).toBeGreaterThan(-1);
    expect(page.indexOf('{PRACTICE_NOTE}')).toBeLessThan(page.indexOf('shown.map'));
  });

  it('never reads a return as late or the checks as assurance (3, 6)', () => {
    expect(page).toMatch(/Some returns coming up:/);
    expect(page).toMatch(/Shap can’t tell whether it was filed/);
    expect(page).toMatch(/Books check:/);
    expect(page).not.toMatch(/Books audit:|every check passes|Not checked yet/);
  });

  it('says what’s needed, where to go, in the house wording (8)', () => {
    expect(server).not.toMatch(/Go back to Clients|under Feedback|Not in a client’s books\. Go back/);
    expect(server).toMatch(/Practice, in the menu/);
    expect(server).toMatch(/tap Feedback, then Bug found/);
  });

  it('sends an unexpected error in a client’s books to the practice’s Feedback, where there is one (8)', () => {
    expect(UNEXPECTED_IN_A_CLIENT).toMatch(/tap Back to the practice, then Feedback/);
    expect(read('../../src/app.ts')).toMatch(/inClient\(\) \? UNEXPECTED_IN_A_CLIENT : UNEXPECTED/);
    expect(read('../../../web/src/components/Feedback.tsx')).toMatch(/if \(useClientHere\(\)\) return null/);
  });

  it('uses curly apostrophes in what the practice’s screens and errors say (7)', () => {
    // A straight apostrophe between letters, in a string or JSX text (not code comments).
    const strings = (src: string) => [...src.matchAll(/'([^'\n]*)'|`([^`\n]*)`|>([^<>{}\n]+)</g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    for (const [name, src] of [['Practice.tsx', page], ['ClientBanner.tsx', banner]] as const) {
      const straight = strings(src).filter((s) => /[A-Za-z]'[A-Za-z]/.test(s));
      expect(straight, name).toEqual([]);
    }
    expect(page).toMatch(/Anyone in its books now is taken out, and nobody opens it until it’s brought back/);
  });

  it('accepts the terms for the practice’s use in a client’s books, and says back what the practice answers for (7)', () => {
    expect(PRACTICE_TERMS_TICK).toMatch(/my practice’s use of Shap on these books/);
    expect(PRACTICE_CAUTION).toMatch(/POPIA/);
    expect(read('../../../web/src/pages/Welcome.tsx')).toMatch(/PRACTICE_TERMS_TICK/);
    expect(read('../../../web/src/pages/Settings.tsx')).toMatch(/PRACTICE_CAUTION/);
  });

  it('describes the feature modestly (12)', () => {
    expect(FEATURES.practice.hint).toMatch(/some of the returns coming up, as aids to check/);
  });
});
