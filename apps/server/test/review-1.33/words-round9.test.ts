import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_TYPE_LABELS, addDays, addMonths, financialYear, formatDate, formatZar, STATEMENT_LINES, vat201Due, vatPeriod } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup } from '../helpers.js';

// Round 9 (words): what the eighth round's fixes say that the code doesn't do. Made-up business,
// names and figures.

const root = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const now = today();

describe('MUST: a company file that changes only a cost type’s kind', () => {
  it('isn’t said to put it on another account', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const bank = await r.src('Business bank');
      const { settings } = await owner.get('/api/reference');
      const fy = financialYear(now, settings.fyEndMonth);
      const job = await owner.post<{ id: string }>('/api/projects', { name: 'Made-up Job', status: 'active' });
      const parts = await r.cat('Parts');
      await owner.post('/api/costs', { date: addDays(fy.start, -30), description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 1_000_000, categoryId: parts, projectId: job.id, sourceId: bank });
      await env.sql`update settings set lock_date = ${addDays(fy.start, -1)}::date where id`;
      const [p] = await env.sql<{ code: string }[]>`select a.code from cost_categories c join accounts a on a.id = c.account_id where c.id = ${parts}`;
      // The same account: only the kind changes.
      const res = await owner.call({ method: 'POST', url: '/api/company-file', payload: { password: 'test-password-1', file: { format: 'shap-company/1', categories: [{ name: 'Parts', kind: 'overhead', account: p!.code }] } } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).not.toMatch(/on another account/);
      await env.sql`update settings set lock_date = null where id`;
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});

describe('MUST: docs/SARS.md’s set-off sentence', () => {
  it('the forecast takes no set-off when what came in and the overdue debt are more than the refund', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const bank = await r.src('Business bank');
      const { settings } = await owner.get('/api/reference');
      await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C' }, 'PUT');
      const current = vatPeriod(now, 'C', settings.fyEndMonth);
      const last = vatPeriod(addMonths(current.start, -1), 'C', settings.fyEndMonth);
      const before = vatPeriod(addMonths(last.start, -1), 'C', settings.fyEndMonth);
      const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
      // Before last: R800 output VAT, overdue, unpaid. Last: R1 000 input VAT, a refund owed.
      const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: before.start, dueDate: addDays(now, 200), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 533_333 }] });
      await owner.post(`/api/documents/${inv.id}/issue`);
      await owner.post('/api/costs', { date: last.start, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: Math.round((100_000 * 115) / 15), vatCents: 100_000, categoryId: await r.cat('Parts'), sourceId: bank });
      // R400 of a refund in, this period, before today.
      const inOn = current.start < now ? current.start : addDays(last.end, -1);
      await owner.post('/api/journals', { date: inOn, description: 'Made-up VAT refund from SARS', lines: [{ accountId: await r.acc('bank'), debitCents: 40_000 }, { accountId: await r.acc('vat'), creditCents: 40_000 }] });
      const f = await cashForecast(env.sql, now);
      const vat = f.items.filter((x) => x.kind === 'vat').reduce((t, x) => t + x.cents, 0);
      // The code: R800 still owed (no set-off, as 400 + 800 > 1 000). SARS.md ("set off ... up to
      // what's still owed of the refund") would have R600 set off, R200 owed.
      expect(vat).toBe(-80_000);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
  it('says the set-off is all or nothing, as the code takes it', () => {
    const register = read('docs/SARS.md').replace(/\s+/g, ' ');
    expect(register).not.toMatch(/taken as set off against it first, up to what's still owed of the refund/);
  });
});

describe('SHOULD: the audit log’s moved amounts', () => {
  const src = read('apps/web/src/components/AuditLog.tsx');
  const js = ts.transpileModule(src.slice(src.indexOf('function accountWords'), src.indexOf('export function AuditLog')), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const detail = new Function('STATEMENT_LINES', 'ACCOUNT_TYPE_LABELS', 'formatZar', 'formatDate', `${js}; return detailText;`)(STATEMENT_LINES, ACCOUNT_TYPE_LABELS, formatZar, formatDate) as (d: Record<string, unknown>) => string;
  it('tell a net amount in from one out', () => {
    const row = (cents: number) => detail({ name: 'Business bank', from: { code: '1000', name: 'Made-up Bank', line: 'cash' }, to: { code: '1004', name: 'Made-up Second Bank', line: 'cash' }, moved: [{ fyEnd: '2027-02-28', cents }] });
    expect(row(-50_000)).not.toBe(row(50_000));
  });
});
