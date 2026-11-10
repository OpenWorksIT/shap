/**
 * From the second review of 1.23, of the fixes (it failed before this fix): a set signed on 1.22 is compared by its four statements only,
 * so a change in the books that keeps each statement line's total but moves the figures in a note
 * (money between two cash accounts, a vehicle's cost from one PPE account to another) isn't seen:
 * the signed note no longer matches the books and stillSigned says it does. 1.23 changed no note's
 * tables except adding the non-cash note, so the others could be compared too. And (latent) the
 * builder number is in the fingerprint, so a later builder 3 drawing the same books would find
 * every builder-2 set changed. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatements, type Statements } from '../../src/statements/build.js';
import { figuresHash, stillSigned } from '../../src/modules/financial-statements.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';
function as122(s: Statements): Statements {
  const { builder: _b, books: _k, ...old } = JSON.parse(JSON.stringify(s)) as Statements;
  old.scf.operating = old.scf.operating.filter((l) => !['finance_costs_back', 'finance_income_back', 'interest_received', 'interest_paid'].includes(l.key));
  old.notes = old.notes.filter((n) => n.key !== 'non_cash');
  return old;
}

describe('a set signed on 1.22, then money moved between two cash accounts', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let r: Awaited<ReturnType<typeof ref>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Legacy (Pty) Ltd', features: { ...settings.features, statements: true } }, 'PUT');
    r = await ref(env.sql);
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 100_000 }, { accountId: await r.acc('share_capital'), creditCents: 100_000 }] });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('notices that the signed cash note no longer matches the books', async () => {
    const signed = as122(await buildStatements(env.sql, FY));
    const cashOnHand = (await env.sql<{ id: string }[]>`select id from accounts where code = '1050'`)[0]!.id;
    await me.post('/api/journals', { date: '2025-09-01', description: 'Float drawn (made up)', lines: [{ accountId: cashOnHand, debitCents: 30_000 }, { accountId: await r.acc('bank'), creditCents: 30_000 }] });
    const now = await buildStatements(env.sql, FY, signed.details);
    const cashNote = (s: Statements) => JSON.stringify(s.notes.find((n) => n.key === 'cash')!.tables);
    expect(cashNote(now)).not.toBe(cashNote(signed));
    expect(stillSigned({ snapshot: signed, snapshotHash: null }, now)).toBe(false);
  });

  it('(latent) keeps a builder-2 set unchanged for a later builder that draws the same books', async () => {
    const now = await buildStatements(env.sql, FY);
    const later = { ...now, builder: 3 } as Statements;
    expect(stillSigned({ snapshot: now, snapshotHash: figuresHash(now) }, later)).toBe(true);
  });
});
