import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CIPC_HINT, COIDA_NOTE, COIDA_REMINDER, COOP_CIPC, ruleWord, setupCautions, termsPoints } from '@shap/shared';

// The words review of 1.33: no promise of a reminder Shap can't always give, the law as it is
// (a mutual association such as FEM, the accountant or a labour practitioner), what's said back
// before the terms, and the screens' smaller words. Made-up examples.

const root = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('CIPC and the Compensation Fund, said as they are', () => {
  it('promises no reminder: Home shows one only for dates in Shap’s tables, and filing is theirs', () => {
    for (const w of [CIPC_HINT, COIDA_REMINDER]) expect(w).not.toMatch(/reminds you .* each year/);
    expect(CIPC_HINT).toMatch(/filing it, with what goes with it, is yours or your accountant’s/);
    expect(COIDA_REMINDER).toMatch(/only for a season in its tables/);
    expect(COIDA_REMINDER).toMatch(/No reminder doesn’t mean nothing is due: watch for the Fund’s notice, or ask your accountant/);
    // No promise of an update (second round).
    for (const w of [COIDA_REMINDER, read('CHANGELOG.md')]) expect(w).not.toMatch(/each year’s (standard )?update adds/i);
    expect(CIPC_HINT).toMatch(/No reminder doesn’t mean nothing is due/);
    for (const page of ['apps/web/src/pages/Welcome.tsx', 'apps/web/src/pages/Settings.tsx']) expect(read(page)).not.toMatch(/reminds you of (CIPC’s annual return|the return of earnings) each year|remind me of the return of earnings each year/);
  });

  it('says most employers register, with the Fund or a mutual association such as FEM, and points to the accountant or a labour practitioner', () => {
    expect(COIDA_NOTE).toMatch(/Most employers, casual workers included, must register under COIDA \(cover for injuries at work\) with the Compensation Fund, or with a licensed mutual association such as FEM/);
    expect(COIDA_NOTE).toMatch(/check with your accountant or a labour practitioner/);
    expect(COIDA_NOTE).toMatch(/Settings → Company/);
    expect(COOP_CIPC).toBe('A co-operative files an annual return with CIPC each year. Shap doesn’t work out its date or show it on Home: filing it is yours or your accountant’s.');
  });

  it('says back before the terms what the owner answered about the Fund and the date of incorporation', () => {
    const base = { vatRegistered: false, employees: false, casual: true };
    expect(setupCautions({ ...base, coidaRegistered: 'unsure' })).toContain(COIDA_NOTE);
    expect(setupCautions({ ...base, coidaRegistered: 'no' })).toContain(COIDA_NOTE);
    expect(setupCautions({ ...base, coidaRegistered: 'yes' })).not.toContain(COIDA_NOTE);
    // Registered: told the reminder shows only for a season in Shap's tables (second round).
    expect(setupCautions({ ...base, coidaRegistered: 'yes' })).toContain(`Compensation Fund: ${COIDA_REMINDER} Filing it is yours.`);
    expect(setupCautions({ vatRegistered: false, employees: false, cipc: true, incorporatedOn: null }).join(' ')).toMatch(/Shap won’t show CIPC’s annual return on Home/);
    expect(setupCautions({ vatRegistered: false, employees: false, cipc: true, incorporatedOn: '2020-07-01' }).join(' ')).not.toMatch(/CIPC/);
    expect(setupCautions({ vatRegistered: false, employees: false, coop: true })).toContain(COOP_CIPC);
    const filing = termsPoints('shap').find((p) => p.title === 'You are responsible for what you file and pay')!;
    expect(filing.body).toMatch(/SARS, the Department of Employment and Labour, CIPC and the Compensation Fund/);
    expect(read('apps/web/src/pages/Welcome.tsx')).toMatch(/coidaRegistered: employees \|\| casual \? coida : null, cipc: Boolean\(cipcKind\(f\.businessType\)\), incorporatedOn: f\.incorporatedOn, coop: f\.businessType === 'coop'/);
  });
});

describe('the smaller words', () => {
  it('doesn’t promise for the browser what Shap can’t: Shap sends the camera’s picture nowhere', () => {
    const scan = read('apps/web/src/components/Barcode.tsx');
    expect(scan).not.toMatch(/nothing is sent anywhere/);
    expect(scan).toMatch(/Shap doesn’t send the camera’s picture anywhere: the browser reads the code on this device/);
    // Closed before the camera was asked for: it isn't.
    expect(scan).toMatch(/if \(stopped\) return;\s+stream = await navigator\.mediaDevices\.getUserMedia/);
    for (const doc of ['CHANGELOG.md', 'docs/GOALPOSTS.md', 'README.md']) expect(read(doc)).not.toMatch(/nothing (is )?sent anywhere/);
  });

  it('starts a rule from the statement’s own word, says a supplier is saved with it, and how a rule’s line is captured', () => {
    expect(ruleWord('POS PURCHASE ENGEN BLUEWATER BAY 4567*1234')).toBe('ENGEN');
    expect(ruleWord('DEBIT ORDER MADE-UP INSURER')).toBe('MADE');
    const bank = read('apps/web/src/pages/Bank.tsx');
    expect(bank).toMatch(/setRuling\(ruleWord\(l\.description\)\)/);
    expect(bank).toMatch(/, with the supplier “\$\{supplier\}”/);
    expect(bank).toMatch(/Nothing is captured until you tick it and tap Capture ticked\./);
    expect(bank).toMatch(/choose what it is \(a cost type, or income\) and tap Always this/);
  });

  it('doesn’t claim a reminder Home doesn’t show, or use internal words in a public doc', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/returns coming up: VAT201, EMP201, provisional tax/);
    expect(read('docs/GOALPOSTS.md')).not.toMatch(/chatbots|wording rule/);
    expect(read('apps/web/src/pages/Sales.tsx')).not.toMatch(/add it under Items/);
  });
});

describe('the second round’s words', () => {
  it('Home’s undated Fund reminder doesn’t say its dates are in Shap’s tables', () => {
    const home = read('apps/web/src/pages/Home.tsx');
    expect(home).toMatch(/\{t\.due \? RETURN_NOTE\[t\.body\] : RETURN_NOTE\.undated\}/);
    expect(home).toMatch(/undated: 'not advice\. Shap files nothing with the Fund: you or your accountant file it\.'/);
  });

  it('budgets compare the same accounts, and say which aren’t in it', () => {
    const page = read('apps/web/src/pages/Budgets.tsx');
    expect(page).toMatch(/const budgeted = data\.lines\.filter\(\(l\) => l\.budget\);/);
    expect(page).toMatch(/in the figures above, so actual profit for the whole business differs/);
    expect(page).not.toMatch(/Budgets are for twelve months/);
  });

  it('the rules list says when a rule isn’t applied, and the forecast names dividends tax', () => {
    expect(read('apps/web/src/pages/Bank.tsx')).toMatch(/not applied: its \{r\.categoryName \? 'cost type' : 'income account'\} isn’t in use/);
    expect(read('apps/web/src/pages/Forecast.tsx')).toMatch(/dividends tax \(DTR01\) on its date/);
    expect(read('apps/web/src/components/HowItWorks.tsx')).toMatch(/what’s due to SARS and others/);
  });
});
