import { describe, expect, it } from 'vitest';
import { suggestAccount } from '../../src/modules/movein.js';

// The seventh round of 1.33's reviews (SARS): the sixth round's move-in guesses. A liability named as owed is SARS's,
// whatever else its name says. Made-up account names as other packages use them.

const acc = (systemKey: string, type: 'asset' | 'liability' | 'expense' = 'liability') => ({ id: systemKey, code: '', name: `Made-up ${systemKey}`, type, systemKey });
const accounts = ['paye_payable', 'uif_payable', 'sdl_payable', 'wages_payable', 'payables', 'vat', 'income_tax_payable', 'dwt_payable'].map((k) => acc(k)).concat([acc('general_labour', 'expense')]);
const guess = (name: string, cents: number) => suggestAccount({ code: '', name, cents } as never, accounts);

describe('SHOULD: UIF owed, named with "contributions", "employer" or "company"', () => {
  it('is SARS’s UIF payable, not a trade creditor', () => {
    expect(guess('UIF contributions payable', -250_000)).toBe('uif_payable');
    expect(guess('Employer UIF payable', -120_000)).toBe('uif_payable');
    expect(guess('UIF payable - company portion', -120_000)).toBe('uif_payable');
  });
  it('the expense still isn’t', () => {
    expect(guess('UIF company contributions', 600_000)).not.toBe('uif_payable');
    expect(guess('Employer UIF contributions', 600_000)).not.toBe('uif_payable');
  });
});

describe('NOTE: dividends withholding tax by its long name', () => {
  it('is SARS’s dividends tax payable, not a trade creditor', () => {
    expect(guess('Dividends withholding tax payable', -300_000)).toBe('dwt_payable');
  });
});
