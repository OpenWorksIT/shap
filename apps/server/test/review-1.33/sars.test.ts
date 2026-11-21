import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The SARS review of 1.33: the register says what changed, with its sources.
const register = readFileSync(join(__dirname, '..', '..', '..', '..', 'docs', 'SARS.md'), 'utf8');

describe('the SARS register for 1.33', () => {
  it('cites the Acts, the Fund’s later notice, and co-operatives', () => {
    expect(register).toMatch(/\[Close Corporations Act s15A\]\(https:\/\/www\.acts\.co\.za\/close-corporations-act-1984\/15a__annual_return\)/);
    expect(register).toMatch(/Notice 4140 of 2026/);
    expect(register).toMatch(/A co-operative files one with CIPC too: Shap doesn't work out its date/);
    expect(register).not.toMatch(/no other kind of business files one/);
  });

  it('has the forecast’s tax figures, and says what’s Shap only', () => {
    expect(register).toMatch(/### The cash-flow forecast's tax figures \(Shap only, estimates\)/);
    expect(register).toMatch(/The employment tax incentive isn't taken off/);
    expect(register).toMatch(/Always\s+eFiling's date\s+\(the last business day\), never the 25th/);
    // Second round: journals count in their period, an older return is this week's, a business no longer registered.
    expect(register).toMatch(/journals\s+by hand and books brought in count in their own period/);
    expect(register).toMatch(/anything older this week/);
    expect(register).toMatch(/A business no longer registered still has what's in its VAT account forecast/);
    expect(register).toMatch(/except what's marked\s+\*Shap only\*/);
    expect(register).toMatch(/CIPC, the Compensation Fund and the forecast's tax figures on 21 November 2026 \(1\.33\)/);
  });
});
