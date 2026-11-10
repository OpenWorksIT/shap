/**
 * From the independent review of 1.23 (it failed before the fix): statements compiled on 1.22 and
 * not yet approved couldn't be approved after the upgrade, and approved ones said "the books have
 * changed": their fingerprint covered the cash flows, which 1.23 draws differently from the same
 * books. A set signed from 1.23 is fingerprinted by the books themselves; one signed before is
 * compared by its four statements. A close corporation's set signed before 1.23 keeps no
 * accounting officer's report it was never signed with. All data made up.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@shap/shared';
import { buildStatements, type Statements } from '../../src/statements/build.js';
import { renderStatementsPdf } from '../../src/statements/pdf.js';
import { figuresHash, stillSigned } from '../../src/modules/financial-statements.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';
const pdfText = async (buf: Buffer) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let out = '';
  for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  return out.replace(/\s+/g, ' ');
};

/** A set as 1.22 froze it: no builder or books fingerprint, the cash flows drawn without the interest lines. */
function as122(s: Statements): Statements {
  const { builder: _b, books: _k, ...old } = JSON.parse(JSON.stringify(s)) as Statements;
  old.scf.operating = old.scf.operating.filter((l) => !['finance_costs_back', 'finance_income_back', 'interest_received', 'interest_paid'].includes(l.key));
  old.notes = old.notes.filter((n) => n.key !== 'non_cash');
  return old;
}

describe('statements signed before 1.23, after the upgrade', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let r: Awaited<ReturnType<typeof ref>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Upgrade (Pty) Ltd', regNumber: '2021/654321/07', address: '1 Test Street, Fictional Town, 0001', features: { ...settings.features, statements: true } }, 'PUT');
    r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 100_000 }, { accountId: await r.acc('share_capital'), creditCents: 100_000 }] });
    await me.post('/api/costs', { date: '2025-08-31', description: 'Bank interest (made up)', amountCents: 4_500, vatCents: 0, vatCode: 'exempt', categoryId: await r.cat('Interest'), sourceId: bank });
    await me.post('/api/statements/details', { directors: [{ name: 'Fictional Director', role: 'Director' }], compiler: { name: 'Fictional Accountant', qualification: 'CA(SA)' } }, 'PUT');
  });
  afterAll(() => env.close());

  it('fingerprints with SHA-256 in plain JavaScript (Shap Pocket’s books run where Node’s isn’t), the same as Node’s', () => {
    for (const t of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'Fictional rand R1 000 — “quoted” ✓'])
      expect(sha256Hex(t)).toBe(createHash('sha256').update(t).digest('hex'));
  });

  it('fingerprints a set by the books, so drawing them differently isn’t a change', async () => {
    const now = await buildStatements(env.sql, FY);
    expect(now.builder).toBe(2);
    const redrawn = { ...now, scf: { ...now.scf, operating: [] } };
    expect(figuresHash(redrawn)).toBe(figuresHash(now));
  });

  it('approves a set compiled on 1.22 when the books haven’t changed', async () => {
    const old = as122(await buildStatements(env.sql, FY));
    await env.sql`insert into financial_statements (fy_end, status, snapshot, snapshot_hash, compiler, compiled_on, compiled_at)
      values (${FY}, 'compiled', ${env.sql.json(old as never)}, ${figuresHash(old)}, ${env.sql.json({ name: 'Fictional Accountant', date: '2026-05-01', how: 'in_shap' } as never)}, '2026-05-01', now())`;
    expect((await me.get(`/api/statements/${FY}`)).changedSince).toBe(false);
    const res = await me.call({ method: 'POST', url: `/api/statements/${FY}/approve`, payload: { name: 'Fictional Director', date: '2026-05-02' } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await me.get(`/api/statements/${FY}`)).changedSince).toBe(false);
  });

  it('still notices when the books did change under a set signed before 1.23', async () => {
    const [row] = await env.sql<{ snapshot: Statements }[]>`select snapshot from financial_statements where fy_end = ${FY}`;
    const snapshot = row!.snapshot;
    const now = await buildStatements(env.sql, FY, snapshot.details);
    expect(stillSigned({ snapshot, snapshotHash: null }, now)).toBe(true);
    const moved = { ...now, sci: { ...now.sci, revenue: [...now.sci.revenue, { key: 'revenue', label: 'Revenue', current: 1, prior: 0 }] } } as Statements;
    expect(stillSigned({ snapshot, snapshotHash: null }, moved)).toBe(false);
    await expectCleanAudit(env.sql, FY);
  });

  it('prints a close corporation’s accounting officer’s report only on a set drawn from 1.23', async () => {
    const s = await buildStatements(env.sql, FY);
    const cc = { ...s, company: { ...s.company, businessType: 'cc' as const } };
    expect(await pdfText(await renderStatementsPdf(cc, {}))).toContain('Report of the accounting officer');
    expect(await pdfText(await renderStatementsPdf(as122(cc), {}))).not.toContain('Report of the accounting officer');
  });
});
