/**
 * The 1.31.0 words review: what the screens, the changelog and the docs say of engagement letters,
 * working papers and the compilation report, read from their source as the 1.30 words tests do. Each
 * check failed on 1.31.0 as the review found it. Shap Pocket's screens are read where they're next to
 * this repository (its own tests check them too).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LETTER_END_CONFIRM, LETTER_SENT_CONFIRM, TASKS } from '@shap/shared';

const ROOT = join(import.meta.dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const POCKET = join(ROOT, '../shap-pocket');

describe('the words on letters and working papers', () => {
  const page = read('apps/web/src/pages/PracticeFile.tsx');

  it('one name for the page: “Working papers and letters”', () => {
    expect(page).toMatch(/sub="Working papers and letters"/);
    expect(page).not.toMatch(/Working papers and engagement letters/);
    expect(read('apps/web/src/pages/Practice.tsx')).toMatch(/Working papers and letters/);
  });

  it('Shap doesn’t send a letter: marking it as sent asks first, and says so', () => {
    expect(LETTER_SENT_CONFIRM).toBe('Its words are kept as they are from now. Shap doesn’t send it: download its PDF and send it to them yourself.');
    expect(page).toMatch(/confirm\(`Mark this letter as sent\? \$\{LETTER_SENT_CONFIRM\}`\)/);
    expect(page).toMatch(/Draft PDF \(to read\)/);
  });

  it('the letter’s note is in the drawer where its words are changed, and the parties are changed there too', () => {
    const edit = page.slice(page.indexOf('function EditLetter'), page.indexOf('function signedCopy'));
    expect(edit).toMatch(/\{LETTER_NOTE\}/);
    expect(edit).toMatch(/its words and parties are kept as they are/);
    for (const field of ['practiceName', 'practiceReg', 'practiceTrading', 'practiceAddress', 'clientName']) expect(edit).toMatch(new RegExp(`party\\('${field}'\\)`));
  });

  it('ending a letter says it doesn’t end the engagement, and asks for the last year it covers', () => {
    expect(LETTER_END_CONFIRM).toMatch(/doesn’t end the engagement with the client/);
    expect(page).not.toMatch(/a new letter takes its place/);
    const end = page.slice(page.indexOf('function EndLetter'));
    expect(end).toMatch(/sub=\{LETTER_END_CONFIRM\}/);
    expect(end).toMatch(/The last year it covers/);
  });

  it('an acceptance is “recorded”, and a photo of the signed copy is made smaller (and its details dropped) first', () => {
    expect(page).toMatch(/toast\('Recorded as accepted'\)/);
    expect(page).toMatch(/squeezePhoto\(file, \{ pixels: 2_000_000, quality: 0\.75 \}\)/);
    expect(page).toMatch(/A photo is made smaller before it goes up; a PDF goes up as it is \(6 MB at most\)/);
  });

  it('opening a note again, or raising one, says it takes back the review and the partner’s sign-off', () => {
    expect(page).toMatch(/Open this note again\? The year’s Reviewed and Engagement partner sign-offs are taken back/);
    expect(page).toMatch(/Raise this note\? The year’s Reviewed and Engagement partner sign-offs are taken back/);
    expect(page).toMatch(/a note raised or opened again takes them back/);
  });

  it('the list doesn’t warn for a letter that isn’t for compiling, and says a partner’s sign-off wasn’t reviewed', () => {
    const list = read('apps/web/src/pages/Practice.tsx');
    const line = list.slice(list.indexOf('function PapersLine'), list.indexOf('/** Who opens it'));
    expect(line).toMatch(/letter accepted \(not for compiling\)/);
    expect(line).not.toMatch(/no accepted letter covers compiling this year/);
    expect(line).not.toMatch(/const warn = [^;]*!p\.compiling/);
    expect(line).toMatch(/signed off by the engagement partner, not reviewed/);
    expect(read('apps/web/src/pages/FinancialStatements.tsx')).toMatch(/the engagement partner signed off with no review recorded/);
  });

  it('the tasks’ hints: whose letters, and the working papers', () => {
    const tasks = TASKS;
    expect(tasks.find((t) => t.key === 'practice.manage')!.hint).toMatch(/engagement letters with its clients$/);
    expect(tasks.find((t) => t.key === 'practice.clients')!.hint).toMatch(/working papers/);
  });

  it('the changelog and docs don’t claim the letter meets ISRS 4410, or the file is the whole of para 38', () => {
    const log = read('CHANGELOG.md');
    const v131 = log.slice(log.indexOf('## 1.31.0'), log.indexOf('## 1.30.0'));
    expect(v131).toMatch(/drafted to cover what ISRS 4410 \(Revised\) para 24 asks the agreed terms to say;\s+whether it does for an engagement is the practitioner's to check/);
    expect(v131).not.toMatch(/it says what ISRS 4410 \(Revised\) asks/);
    expect(v131).toMatch(/as ISRS 4410 \(Revised\)'s example reports title it/);
    expect(v131).toMatch(/download its PDF and send it yourself \(Shap doesn't send it\)/);
    const docs = read('docs/ACCOUNTANT.md');
    expect(docs).toMatch(/drafted to cover what ISRS 4410 \(Revised\) para 24 asks the agreed\s+terms to say; whether it does for an engagement is the practitioner's to check/);
    expect(docs).toMatch(/an aid towards the practice's record of the engagement \(para 38\), not the whole of it/);
    expect(docs).toMatch(/at least 51 per cent of the members' interest/);
    expect(docs).not.toMatch(/at least half of the members/);
  });

  it('the screens call it the compilation report, in Shap and in Shap Pocket', () => {
    expect(read('apps/web/src/pages/FinancialStatements.tsx')).not.toMatch(/compiler’s report|Compiler’s report/);
    if (existsSync(POCKET))
      for (const f of ['apps/web/src/pages/FinancialStatements.tsx', 'apps/web/src/pages/Welcome.tsx']) expect(readFileSync(join(POCKET, f), 'utf8')).not.toMatch(/compiler’s report|Compiler’s report/);
  });
});
