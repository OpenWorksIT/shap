/**
 * Files and text from outside, from the security review shared with Shap: imports that can't
 * freeze the app, a company file checked as if typed into Settings, and exports a spreadsheet
 * can't run as formulas, whichever list separator it's set to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeText, toDelimited } from '@shap/shared';
import { toCsv } from '../src/lib/books.js';
import { parseStatementAmount, parseStatementDate } from '../src/modules/bank/parse.js';
import { MAX_CSV_CELL, parseCsv, readClientCsv } from '../src/modules/clients.js';
import { suggestAccount } from '../src/modules/movein.js';
import { login, setup, type TestEnv } from './helpers.js';

const quick = <T>(fn: () => T): { value: T; ms: number } => {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
};

describe('imports can’t freeze the app', () => {
  it('reads statement dates and amounts as before, and gives up on a crafted cell at once', () => {
    expect(parseStatementAmount('120.00 Dr')).toBe(-12000);
    expect(parseStatementDate('03/11/2026')).toBe('2026-11-03');
    for (const cell of ["'".repeat(100_000) + 'x', ' '.repeat(100_000) + 'x']) {
      const a = quick(() => parseStatementAmount(cell));
      const d = quick(() => parseStatementDate(cell));
      expect(a.value).toBeNull();
      expect(d.value).toBeNull();
      expect(a.ms + d.ms).toBeLessThan(50);
    }
  });

  it('caps a CSV’s cells and a client file’s size, and matches long names quickly', () => {
    const [[cell]] = parseCsv(`${'z'.repeat(10_000)}\n`) as [[string]];
    expect(cell.length).toBe(MAX_CSV_CELL);
    expect(() => readClientCsv(['Name', ...Array.from({ length: 6000 }, (_, i) => `Client ${i}`)].join('\n'))).toThrow(/too many clients/);
    const { ms } = quick(() => suggestAccount({ code: '', name: `accum${' '.repeat(200_000)}x`, cents: 0 } as never, []));
    expect(ms).toBeLessThan(100);
  });
});

describe('a company file is checked like Settings', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
  });
  afterAll(() => env.close());

  it('refuses an accent that isn’t a colour, settings that aren’t valid, and over-long text', async () => {
    const restore = (file: unknown) => owner.call({ method: 'POST', url: '/api/company-file', payload: { file } });
    const f = (over: Record<string, unknown>) => ({ format: 'shap-company/1', ...over });
    expect((await restore(f({ brands: [{ name: 'Kestrel Roofing', accent: 'red;background:url(https://example.com/x)' }] }))).statusCode).toBe(400);
    expect((await restore(f({ settings: { vatRateBp: 'lots' } }))).statusCode).toBe(400);
    expect((await restore(f({ clients: [{ name: 'Y'.repeat(5000) }] }))).statusCode).toBe(400);
    expect((await restore(f({ brands: [{ name: 'Kestrel Roofing', accent: '#2f6f4f' }] }))).statusCode).toBe(200);
  });
});

describe('exports a spreadsheet can’t run', () => {
  const runs = (c: string) => /^[=+\-@]/.test(c);
  it('neutralises a formula at the start and straight after any separator, leaving ordinary text alone', () => {
    expect(safeText('Tiles;=cmd|"/c calc"!A0')).toBe(`Tiles;'=cmd|"/c calc"!A0`);
    expect(safeText('Tiles, -5% for cash')).toBe('Tiles, -5% for cash');
    expect(safeText('-12.50')).toBe('-12.50');
    const payload = ['Roof repair', 'x;=HYPERLINK("https://example.com")', 'y,@SUM(1)', 'z\t-2+3'];
    const files = [toCsv(['Description'], payload.map((p) => [p])), toDelimited(['Description'], payload.map((p) => [safeText(p)]), { delimiter: ';', header: true })];
    for (const file of files) {
      for (const line of file.replace(/^﻿/, '').split('\r\n').filter(Boolean)) {
        for (const d of [',', ';', '\t']) for (const c of line.split(d).map((x) => x.replace(/^"/, ''))) expect(runs(c), JSON.stringify(c)).toBe(false);
      }
    }
  });
});
