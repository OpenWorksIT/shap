/**
 * From the second review of 1.23, of the fixes (it failed before this fix): many made-up asset bills with VAT, paid in parts from the bank
 * and by the owner across three years, some with a supplier's credit note on the asset: every
 * year's statement of cash flows must end at the cash. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatements } from '../../src/statements/build.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const day = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

describe('asset bills paid every which way', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const me = await login(env.app, 'owner@example.co.za');
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', companyName: 'Fictional Fuzz (Pty) Ltd', features: { ...settings.features, statements: true, bills: true } }, 'PUT');
    const r = await ref(env.sql);
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    const bank = await r.src('Business bank');
    const owner = await r.src('Paid personally (owner)');
    const assets = await r.cat('Asset purchase');
    await me.post('/api/journals', { date: '2023-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 50_000_000 }, { accountId: await r.acc('share_capital'), creditCents: 50_000_000 }] });
    for (let i = 0; i < 25; i++) {
      const net = int(1_000, 2_000_000);
      const vat = Math.round(net * 0.15) + int(-1, 1);
      const whole = net + vat;
      const y = int(2023, 2025);
      const d = day(y, int(3, 12), int(1, 28));
      const bill = await me.post('/api/costs', { date: d, description: `Asset ${i} (made up)`, supplier: `Fictional Supplier ${i}`, billNumber: `FS-${i}`, amountCents: whole, vatCents: vat, vatCode: 'standard', categoryId: assets, sourceId: bills });
      let left = whole;
      if (rnd() < 0.3) {
        const cn = int(1, Math.floor(whole / 4));
        const cnVat = Math.round((cn * 15) / 115);
        const credit = await me.post('/api/costs', { date: d, description: `Credit ${i} (made up)`, supplier: `Fictional Supplier ${i}`, billNumber: `FS-CN${i}`, amountCents: -cn, vatCents: -cnVat, vatCode: 'standard', categoryId: assets, sourceId: bills });
        const used = await me.call({ method: 'POST', url: `/api/costs/${bill.id}/bill-credits`, payload: { date: d, amountCents: cn, creditId: credit.id } });
        expect(used.statusCode, used.body).toBe(200);
        left -= cn;
      }
      const parts = int(0, 3);
      for (let p = 0; p < parts && left > 0; p++) {
        const amt = p === parts - 1 && rnd() < 0.5 ? left : int(1, left);
        const py = Math.min(2026, y + int(0, 1));
        const pd = day(py, int(3, 12), int(1, 28));
        const date = pd < d ? d : pd;
        if (date > '2026-02-28') continue;
        const res = await me.call({ method: 'POST', url: `/api/costs/${bill.id}/bill-payments`, payload: { date, amountCents: amt, sourceId: rnd() < 0.5 ? bank : owner } });
        if (res.statusCode === 200) left -= amt;
      }
    }
  }, 120_000);
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('ends each year’s cash flows at the cash', async () => {
    const bad: string[] = [];
    for (const fy of ['2024-02-29', '2025-02-28', '2026-02-28']) {
      const s = await buildStatements(env.sql, fy);
      const ok = s.checks.find((c) => c.label === 'The cash flows add up to the change in cash')!;
      if (!ok.ok) bad.push(`${fy}: ${ok.detail} (net ${s.scf.netChange.current}, cash ${s.scf.closing.current - s.scf.opening.current}; prior net ${s.scf.netChange.prior}, cash ${s.scf.closing.prior - s.scf.opening.prior})`);
    }
    expect(bad).toEqual([]);
  });
});
