/**
 * From the independent review of Shap 1.23 and Shap Pocket 1.7 (the same accounting code; each
 * failed before the fix): the assessed loss brought forward, a trust's estimate, a reviewed close
 * corporation's accounting officer's report, an asset's bill the owner paid personally,
 * subcontractors in the public interest score, and statements signed before the update. And from
 * porting the fixes: the statements' fingerprint used node:crypto, which isn't there when the books
 * run in the app (compiling or approving would fail on the phone): plain JavaScript now. All data
 * made up.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { companyTax, sha256Hex } from '@shap/shared';
import { buildStatements, type Statements } from '../src/statements/build.js';
import { renderStatementsPdf } from '../src/statements/pdf.js';
import { taxPack } from '../src/modules/tax-pack.js';
import { figuresHash, stillSigned } from '../src/modules/financial-statements.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const FY = '2026-02-28';
const NEXT = '2027-02-28';
const pdfText = async (buf: Buffer) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let out = '';
  for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  return out.replace(/\s+/g, ' ');
};

let env: TestEnv;
let open = false;
afterEach(async () => {
  if (open) await env.close();
  open = false;
});
const start = async (patch: Record<string, unknown>) => {
  env = await setup();
  open = true;
  const me = await login(env.app);
  const { settings, sources } = await me.get('/api/reference');
  await me.post('/api/settings', { ...settings, fyEndMonth: 2, address: '1 Test Street, Fictional Town, 0001', ...patch, features: { ...settings.features, statements: true, ...((patch.features as object) ?? {}) } }, 'PUT');
  return { me, sources, r: await ref(env.sql) };
};

describe('Shap Pocket', () => {
  it('carries an earlier year’s loss forward past an even earlier profit (no carry-back)', async () => {
    const { me, r } = await start({ companyName: 'Fictional Losses (Pty) Ltd' });
    const bank = await r.acc('bank');
    const revenue = await r.acc('revenue_other');
    const sundry = (await env.sql<{ id: string }[]>`select id from accounts where type = 'expense' and system_key is null limit 1`)[0]!.id;
    const j = (date: string, d: string, c: string, cents: number) => me.post('/api/journals', { date, description: 'Made up', lines: [{ accountId: d, debitCents: cents }, { accountId: c, creditCents: cents }] });
    await j('2023-06-30', bank, revenue, 10_000_000);
    await j('2024-06-30', sundry, bank, 6_000_000);
    await j('2025-06-30', bank, revenue, 20_000_000);
    const s = await buildStatements(env.sql, FY);
    expect.soft(s.taxEstimate?.assessedLossCents, 'statements').toBe(6_000_000);
    expect.soft((await taxPack(env.sql, FY)).assessedLossCents, 'tax pack').toBe(6_000_000);
    expect(s.taxEstimate?.taxCents).toBe(companyTax(14_000_000, FY, false));
    await expectCleanAudit(env.sql, FY);
  });

  it('estimates a trust’s tax after what vested in its beneficiaries, as the tax pack does', async () => {
    const { me, r } = await start({ businessType: 'trust', companyName: 'Fictional Family Trust', features: { dividends: true } });
    await me.post('/api/journals', { date: '2025-06-30', description: 'Income (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000_000 }, { accountId: await r.acc('revenue_other'), creditCents: 10_000_000 }] });
    const res = await me.call({ method: 'POST', url: '/api/dividends', payload: { declaredOn: '2026-02-20', paidOn: '2026-02-25', shareholder: 'Fictional Beneficiary', grossCents: 10_000_000, conduit: true, sourceId: await r.src('Business bank') } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await taxPack(env.sql, FY)).estimate.taxCents).toBe(0);
    expect((await buildStatements(env.sql, FY)).taxEstimate?.taxCents ?? 0).toBe(0);
    await expectCleanAudit(env.sql, FY);
  });

  it('doesn’t say “no audit or review was conducted” for a reviewed close corporation', async () => {
    const { me, r } = await start({ businessType: 'cc', companyName: 'Fictional Review CC', regNumber: '2005/012345/23' });
    await me.post('/api/journals', { date: '2025-03-01', description: 'Member’s loan (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 100_000 }, { accountId: await r.acc('owner_loan'), creditCents: 100_000 }] });
    await me.post('/api/statements/details', { directors: [{ name: 'Fictional Member', role: 'Member' }], assurance: 'independent_review', compiler: { name: 'Fictional Reviewer' } }, 'PUT');
    const s = await buildStatements(env.sql, FY);
    expect(await pdfText(await renderStatementsPdf(s, {}))).not.toContain('no audit or review was conducted');
  });

  it('shows no investing outflow for an asset’s bill the owner paid personally', async () => {
    const { me, sources, r } = await start({ companyName: 'Fictional Owner Pays (Pty) Ltd', features: { bills: true } });
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    const bill = await me.post('/api/costs', { date: '2026-01-20', description: 'Compressor (made up)', supplier: 'Fictional Tools', billNumber: 'FT-77', amountCents: 1_000_000, vatCents: 0, vatCode: 'no_vat', categoryId: await r.cat('Asset purchase'), sourceId: bills });
    await me.post('/api/assets', { name: 'Compressor (made up)', category: 'equipment', purchaseDate: '2026-01-20', costCents: 1_000_000, costId: bill.id, lifeMonths: 60 });
    const paid = await me.call({ method: 'POST', url: `/api/costs/${bill.id}/bill-payments`, payload: { date: '2026-04-10', amountCents: 1_000_000, sourceId: await r.src('Paid personally (owner)') } });
    expect(paid.statusCode, paid.body).toBe(200);
    const next = await buildStatements(env.sql, NEXT);
    expect(next.scf.investing.find((l) => l.key === 'ppe')?.current ?? 0).toBe(0);
    expect(next.scf.financing.find((l) => l.key === 'owner_loans')?.current ?? 0).toBe(0);
    await expectCleanAudit(env.sql, '2026-07-31');
  });

  it('doesn’t count subcontractors as employees in the public interest score', async () => {
    const { me } = await start({ companyName: 'Fictional Builders (Pty) Ltd', features: { workers: true } });
    const subs = [];
    for (let i = 1; i <= 3; i++) subs.push(await me.post('/api/workers', { name: `Fictional Subbie ${i}`, kind: 'subcontractor', dayRateCents: 150_000 }));
    for (let m = 0; m < 12; m++) {
      const d = new Date(Date.UTC(2025, 2 + m, 5)).toISOString().slice(0, 10);
      await me.post('/api/labour', { date: d, entries: subs.map((s) => ({ workerId: s.id, days: 1, wageCents: 150_000, allowanceCents: 0 })) });
    }
    expect((await buildStatements(env.sql, FY)).publicInterest!.employeesWorkedOut).toBe(0);
    await expectCleanAudit(env.sql, FY);
  });

  it('ends the cash flows at the cash for an asset bill split three ways (second review)', async () => {
    const { me, sources, r } = await start({ companyName: 'Fictional Rounding (Pty) Ltd', vatRegistered: true, vatNumber: '4000000002', features: { bills: true } });
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 5_000_000 }, { accountId: await r.acc('share_capital'), creditCents: 5_000_000 }] });
    // R115.00 with R15.00 VAT: R54.94 from the bank, R10.02 by the owner personally, R50.04 owed at the year end.
    const bill = await me.post('/api/costs', { date: '2025-06-01', description: 'Drill (made up)', supplier: 'Fictional Tools', billNumber: 'FT-1', amountCents: 11_500, vatCents: 1_500, vatCode: 'standard', categoryId: await r.cat('Asset purchase'), sourceId: bills });
    await me.post('/api/assets', { name: 'Drill (made up)', category: 'tools', purchaseDate: '2025-06-01', costCents: 10_000, costId: bill.id, lifeMonths: 36 });
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2025-07-01', amountCents: 5_494, sourceId: await r.src('Business bank') });
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2025-07-02', amountCents: 1_002, sourceId: await r.src('Paid personally (owner)') });
    const s = await buildStatements(env.sql, FY);
    expect(s.scf.netChange.current).toBe(s.scf.closing.current - s.scf.opening.current);
    await expectCleanAudit(env.sql, FY);
  });

  it('makes no assessed loss of a trust’s distributions beyond its income (second review)', async () => {
    const { me, r } = await start({ businessType: 'trust', companyName: 'Fictional Family Trust', features: { dividends: true } });
    const bank = await r.acc('bank');
    const rev = await r.acc('revenue_other');
    const j = (date: string, cents: number) => me.post('/api/journals', { date, description: 'Income (made up)', lines: [{ accountId: bank, debitCents: cents }, { accountId: rev, creditCents: cents }] });
    await j('2023-06-30', 5_000_000);
    await j('2024-06-30', 10_000_000);
    const res = await me.call({ method: 'POST', url: '/api/dividends', payload: { declaredOn: '2025-02-20', paidOn: '2025-02-25', shareholder: 'Fictional Beneficiary', grossCents: 15_000_000, conduit: true, sourceId: await r.src('Business bank') } });
    expect(res.statusCode, res.body).toBe(200);
    await j('2025-06-30', 10_000_000);
    expect((await taxPack(env.sql, FY)).assessedLossCents).toBe(0);
    await expectCleanAudit(env.sql, FY);
  });

  it('keeps a set signed before the update signed, and fingerprints new ones by the books', async () => {
    const { me, r } = await start({ companyName: 'Fictional Upgrade (Pty) Ltd', regNumber: '2021/654321/07' });
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 100_000 }, { accountId: await r.acc('share_capital'), creditCents: 100_000 }] });
    await me.post('/api/costs', { date: '2025-08-31', description: 'Bank interest (made up)', amountCents: 4_500, vatCents: 0, vatCode: 'exempt', categoryId: await r.cat('Interest'), sourceId: await r.src('Business bank') });
    const now = await buildStatements(env.sql, FY);
    expect(now.builder).toBe(2);
    expect(figuresHash({ ...now, scf: { ...now.scf, operating: [] } })).toBe(figuresHash(now));
    // As 1.6 froze it: no fingerprint of the books, the cash flows without the interest lines.
    const { builder: _b, books: _k, ...old } = JSON.parse(JSON.stringify(now)) as Statements;
    old.scf.operating = old.scf.operating.filter((l) => !['finance_costs_back', 'interest_paid', 'finance_income_back', 'interest_received'].includes(l.key));
    expect(figuresHash(old as Statements)).not.toBe(figuresHash(now));
    expect(stillSigned({ snapshot: old as Statements, snapshotHash: figuresHash(old as Statements) }, now)).toBe(true);
    expect(stillSigned({ snapshot: old as Statements, snapshotHash: null }, { ...now, sci: { ...now.sci, profit: { current: 1, prior: 0 } } } as Statements)).toBe(false);
    // A note's figures moved (same statement totals): changed too.
    const moved = JSON.parse(JSON.stringify(now)) as Statements;
    moved.notes.find((n) => n.tables.length)!.tables[0]!.rows.push({ label: 'Made up', current: 1, prior: 0 } as never);
    expect(stillSigned({ snapshot: old as Statements, snapshotHash: null }, moved)).toBe(false);
    // A later Shap Pocket that draws the same books: a set signed now stays signed.
    expect(stillSigned({ snapshot: now, snapshotHash: figuresHash(now) }, { ...now, builder: 3 } as Statements)).toBe(true);
    await expectCleanAudit(env.sql, FY);
  });
});

describe('the statements in the app', () => {
  it('fingerprints with SHA-256 in plain JavaScript, the same as Node’s', () => {
    for (const t of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'Fictional rand R1 000 — “quoted” ✓'])
      expect(sha256Hex(t)).toBe(createHash('sha256').update(t).digest('hex'));
  });

  it('don’t reach for Node’s own modules anywhere in the engine, which the app doesn’t have', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(40);
    for (const f of files) expect(readFileSync(join(root, f), 'utf8'), f).not.toMatch(/from ['"](node:|crypto['"]|fs['"]|path['"])/);
  });
});
