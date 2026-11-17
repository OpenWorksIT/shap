/**
 * The 1.31.0 IFRS review of the practitioner's compilation report (statements/pdf.ts, the same in
 * Shap Pocket): a special purpose framework's paragraph (ISRS 4410 (Revised) para 40(j), Appendix 2
 * Illustration 2) for a sole proprietor, a partnership or a trust; the directors named where the
 * report is addressed to a company's shareholders or a co-op's members (para 40(c)-(d)); and the
 * limitation sentence naming the same framework as the paragraph before it. All data made up.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { BusinessType } from '@shap/shared';
import { buildStatements } from '../../src/statements/build.js';
import { renderStatementsPdf } from '../../src/statements/pdf.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';
const pdfText = async (buf: Buffer) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let out = '';
  for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  return out.replace(/\s+/g, ' ');
};

describe('the practitioner’s compilation report', () => {
  let env: TestEnv | null = null;
  afterAll(async () => {
    if (env) {
      await expectCleanAudit(env.sql);
      await env.close();
    }
  });

  /** A year of made-up books for a business of this kind, its statements compiled: the report's words. */
  const reportOf = async (bt: BusinessType) => {
    if (env) {
      await expectCleanAudit(env.sql);
      await env.close();
    }
    env = await setup();
    const me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Report Test', businessType: bt, fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
    const r = await ref(env.sql);
    const equity = bt === 'company' || bt === 'inc' || bt === 'coop' ? await r.acc('share_capital') : await r.acc('owner_loan');
    await me.post('/api/journals', { date: '2025-04-01', description: 'Made-up capital', lines: [{ accountId: await r.acc('bank'), debitCents: 400_000 }, { accountId: equity, creditCents: 400_000 }] });
    await me.post('/api/journals', { date: '2025-05-01', description: 'Made-up rent', lines: [{ accountId: await r.acc('rent'), debitCents: 50_000 }, { accountId: await r.acc('bank'), creditCents: 50_000 }] });
    const s = await buildStatements(env.sql, FY);
    const text = await pdfText(await renderStatementsPdf({ ...s, details: { ...s.details, assurance: 'compiled' } }, { compiler: { name: 'Fictional Accountant', date: '2026-04-01', how: 'uploaded' } }));
    return text.slice(text.indexOf('Practitioner’s compilation report'));
  };

  it('a sole proprietor’s: special purpose, for the owner and SARS, and may not be suitable for other purposes', async () => {
    const t = await reportOf('sole_prop');
    expect(t).toMatch(/As noted in note 1, the financial statements are prepared and presented on the basis described in note 1, for the owner and the South African Revenue Service\. Accordingly, these financial statements may not be suitable for other purposes\./);
    expect(t).toMatch(/whether these financial statements are prepared in accordance with the basis of accounting described in note 1/);
    // Addressed to the owner, who gave the information: "you".
    expect(t).toMatch(/To the owner of Fictional Report Test/);
    expect(t).toMatch(/based on information you have provided/);
    // Note 1 says it for the owner, in the singular.
    expect(await pdfText(await renderStatementsPdf(await buildStatements(env!.sql, FY), {}))).toMatch(/recognition and measurement principles of .{0,80}for the owner and the South African Revenue Service/);
  });

  it('a trust’s and a partnership’s too', async () => {
    expect(await reportOf('trust')).toMatch(/may not be suitable for other purposes/);
    expect(await reportOf('partnership')).toMatch(/for the partners and the South African Revenue Service\. Accordingly, these financial statements may not be suitable for other purposes/);
  });

  it('a company’s: to its shareholders, from information the directors provided, the directors’ responsibility, and the framework with its Act', async () => {
    const t = await reportOf('company');
    expect(t).toMatch(/To the shareholders of Fictional Report Test/);
    expect(t).toMatch(/based on information provided by the directors/);
    expect(t).toMatch(/to assist the directors in the preparation and presentation/);
    expect(t).toMatch(/are the directors’ responsibility/);
    expect(t).toMatch(/the information the directors provided to us/);
    expect(t).not.toMatch(/information you have provided|your responsibility|assist you/);
    // The limitation sentence names the framework the paragraph before it does, its Act included.
    expect(t).toMatch(/on whether these financial statements are prepared in accordance with the IFRS for SMEs Accounting Standard.{0,40} and the requirements of the Companies Act 71 of 2008/);
    expect(t).not.toMatch(/may not be suitable for other purposes/);
  });

  it('a co-op’s: to its members, the directors named; a CC’s: to its members, who gave the information', async () => {
    const coop = await reportOf('coop');
    expect(coop).toMatch(/To the members of Fictional Report Test/);
    expect(coop).toMatch(/based on information provided by the directors/);
    expect(coop).toMatch(/and the requirements of the Co-operatives Act 14 of 2005\./);
    const cc = await reportOf('cc');
    expect(cc).toMatch(/based on information you have provided/);
    expect(cc).toMatch(/and the requirements of the Close Corporations Act 69 of 1984\./);
  });
});
