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
    expect(register).toMatch(/The\s+employment tax incentive isn't taken off/);
    expect(register).toMatch(/Always\s+eFiling's date\s+\(the last business day\), never the 25th/);
    // Second round: journals count in their period, an older return is this week's, a business no longer registered.
    // Fourth and fifth rounds: VAT against money (a card or any account paid from too), with at most SARS's interest beside it.
    expect(register).toMatch(/except payments and refunds \(an entry of VAT against\s+money: the bank, cash, an overdraft, a card or any account paid from, or the owner's loan, with\s+at most expense or income smaller than the VAT beside it: SARS's interest or a penalty, or\s+interest on a refund\)/);
    // Sixth round: SARS's other taxes count as money; a refund isn't netted off any other period's.
    expect(register).toMatch(/SARS's other tax accounts \(PAYE, UIF, SDL, income\s+tax and dividends tax owed\) count as money for this test/);
    expect(register).toMatch(/A refund SARS owes isn't\s+netted off what's owed for another period \(last period's or an older one, paid on time or not\),\s+nor forecast as money in/);
    // Seventh and eighth rounds: once one has come in, overdue VAT is taken as set off first (s191(1)).
    expect(register).toMatch(/Once one\s+has come in, VAT already overdue for an ended period is taken as set off against it first/);
    expect(register).not.toMatch(/only the timing is off/);
    expect(register).not.toMatch(/A VAT payment by card/);
    expect(register).toMatch(/the split is an\s+estimate/);
    expect(register).toMatch(/anything older this week/);
    expect(register).toMatch(/A business no longer registered still has what's in its VAT account forecast/);
    expect(register).toMatch(/except what's marked\s+\*Shap only\*/);
    expect(register).toMatch(/CIPC, the Compensation Fund and the forecast's tax figures on 21 November 2026 \(1\.33\)/);
  });
});
