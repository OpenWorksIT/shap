import { describe, expect, it } from 'vitest';
import { centsToInput, financialYear, formatZar, lineTotal, monthsBetween, parseZarToCents, vatIncluded } from '@shap/shared';
import { parseCsv } from '../src/modules/clients.js';

describe('money', () => {
  it('parses what people type', () => {
    expect(parseZarToCents('450')).toBe(45000);
    expect(parseZarToCents('R 1 200,50')).toBe(120050);
    expect(parseZarToCents('1,200.50')).toBe(120050);
    expect(parseZarToCents('-30')).toBe(-3000);
    expect(parseZarToCents('abc')).toBeNull();
  });
  it('formats rands with spaces', () => {
    expect(formatZar(123456789)).toBe('R 1 234 567.89');
    expect(formatZar(-5000, { cents: false })).toBe('-R 50');
    expect(centsToInput(120050)).toBe('1200.50');
    expect(centsToInput(45000)).toBe('450');
  });
  it('rounds line totals and VAT to the cent', () => {
    expect(lineTotal(2.5, 33333)).toBe(83333);
    expect(vatIncluded(11500, 1500)).toBe(1500);
  });
});

describe('financial year', () => {
  it('ends in February by default for SA companies', () => {
    expect(financialYear('2025-02-28', 2)).toEqual({ start: '2024-03-01', end: '2025-02-28', label: 'FY2025' });
    expect(financialYear('2025-03-01', 2)).toEqual({ start: '2025-03-01', end: '2026-02-28', label: 'FY2026' });
    expect(financialYear('2024-02-10', 2).end).toBe('2024-02-29');
    expect(financialYear('2025-06-30', 12)).toEqual({ start: '2025-01-01', end: '2025-12-31', label: '2025' });
  });
  it('lists months', () => {
    expect(monthsBetween('2024-11-18', '2025-02-01')).toEqual(['2024-11', '2024-12', '2025-01', '2025-02']);
  });
});

describe('CSV', () => {
  it('reads quoted fields, commas and semicolons', () => {
    expect(parseCsv('Name,Email\n"Smith, Jan",jan@x.com\n')).toEqual([['Name', 'Email'], ['Smith, Jan', 'jan@x.com']]);
    expect(parseCsv('\uFEFFName;Number\nA;Smith001\r\n')).toEqual([['Name', 'Number'], ['A', 'Smith001']]);
  });
});
