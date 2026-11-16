/**
 * The SARS and tax review of Shap 1.27.0 (CPDAUDIT.md section 7): the returns the practice's list
 * shows for a client (packages/shared/src/practice.ts deadlinesFor). Each case failed before its fix.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deadlinesFor, isBusinessDay, PRACTICE_NOTE, type DeadlineInputs } from '@shap/shared';

const base: DeadlineInputs = { businessType: 'company', vatRegistered: false, vatCategory: 'A', fyEndMonth: 2, turnoverTax: false, employer: false };
const keys = (c: Partial<DeadlineInputs>, on: string) => deadlinesFor({ ...base, ...c }, on);
const find = (c: Partial<DeadlineInputs>, on: string, key: string) => keys(c, on).find((d) => d.key === key);

describe('the returns on the practice’s list', () => {
  it('gives a non-profit company its returns: as a company, or an approved PBO’s IT12EI and no provisional tax (1)', () => {
    expect(find({ businessType: 'npc' }, '2027-02-10', 'irp6b-2027-02-28')?.due).toBe('2027-02-26');
    expect(find({ businessType: 'npc' }, '2027-02-10', 'itr14-2026-02-28')?.due).toBe('2027-02-26');
    const pbo = keys({ businessType: 'npc', approvedPbo: true }, '2027-02-10');
    expect(pbo.find((d) => d.key === 'it12ei-2026-02-28')?.due).toBe('2027-02-26');
    expect(pbo.some((d) => d.key.startsWith('irp6'))).toBe(false);
  });

  it('gives a company on turnover tax its TT03, not an ITR14 (3)', () => {
    const tt = keys({ turnoverTax: true }, '2027-02-01');
    expect(tt.some((d) => /ITR14/.test(d.label))).toBe(false);
    expect(tt.find((d) => d.key === 'tt03-2026-02-28')?.due).toBe('2027-02-26');
  });

  it('shows what fell due in the window behind, however far back the period ended (4)', () => {
    expect(find({ fyEndMonth: 12 }, '2026-01-10', 'itr14-2024-12-31')).toEqual({ key: 'itr14-2024-12-31', label: 'ITR14 for the year to December 2024', due: '2025-12-31', past: true });
    expect(find({ vatRegistered: true, vatCategory: 'C' }, '2026-11-10', 'vat201-2026-08-31')).toMatchObject({ due: '2026-09-30', past: true });
    // From about the 24th, the EMP201 due on the 7th of the month after next is in the window.
    expect(find({ employer: true }, '2026-11-24', 'emp201-2026-12')?.due).toBe('2027-01-07');
  });

  it('shows the voluntary third (top-up) provisional payment (5)', () => {
    expect(find({ businessType: 'trust' }, '2026-09-10', 'irp6c-2026-02-28')?.due).toBe('2026-09-30');
    expect(find({ fyEndMonth: 6 }, '2026-12-01', 'irp6c-2026-06-30')?.due).toBe('2026-12-31');
  });

  it('shows the filing season’s own dates from the table (7)', () => {
    expect(find({ businessType: 'trust' }, '2027-01-10', 'itr12t-2026')?.due).toBe('2027-01-22');
    expect(find({ employer: true }, '2026-11-17', 'emp501-2027-interim')).toMatchObject({ due: '2026-10-30', past: true });
    // Dividends tax by the end of the month after the dividend was paid.
    expect(find({ dividendsPaid: ['2026-10-15'] }, '2026-11-16', 'dtr01-2026-10')?.due).toBe('2026-11-30');
  });

  it('says a partnership’s provisional tax is each partner’s own (8)', () => {
    const p = keys({ businessType: 'partnership' }, '2026-08-10');
    expect(p.find((d) => d.key.startsWith('irp6a'))?.label).toMatch(/partner/i);
    // And no label gives a bare year (words review 11).
    for (const t of ['sole_prop', 'partnership', 'company', 'trust', 'npc', 'cc'] as const) {
      for (const d of keys({ businessType: t }, '2026-08-10')) expect(d.label).not.toMatch(/\(IRP6, \d{4}\)/);
    }
  });

  it('says the VAT201 date is eFiling’s (9)', () => {
    for (const d of keys({ vatRegistered: true }, '2026-11-17').filter((x) => x.key.startsWith('vat201-'))) expect(d.label).toMatch(/eFiling/);
  });

  it('ends a trust’s Category E VAT period on its year of assessment (10)', () => {
    expect(find({ businessType: 'trust', fyEndMonth: 6, vatRegistered: true, vatCategory: 'E' }, '2026-03-20', 'vat201-2026-02-28')?.due).toBe('2026-03-31');
  });

  it('knows a public holiday the President declared for one year (the minor note)', () => {
    expect(isBusinessDay('2026-11-04')).toBe(false);
    expect(isBusinessDay('2026-11-05')).toBe(true);
  });

  it('lists these dates in the SARS register, so a SARS change leads to them (11)', () => {
    const register = readFileSync(new URL('../../../../docs/SARS.md', import.meta.url), 'utf8');
    expect(register).toMatch(/deadlinesFor/);
    expect(register).toMatch(/FILING_SEASON_DATES/);
    expect(register).toMatch(/DECLARED_HOLIDAYS/);
  });

  it('says OpenWorks are not tax practitioners, beside the returns (12)', () => {
    expect(PRACTICE_NOTE).toMatch(/not accountants, tax practitioners or auditors/);
    const page = readFileSync(new URL('../../../web/src/pages/Practice.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(/PRACTICE_NOTE/);
  });
});
