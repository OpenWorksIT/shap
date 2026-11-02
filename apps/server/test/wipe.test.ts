/** Wipe all data: the owner's password and the business's name, then the books start over; the people who sign in stay. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup, type TestEnv } from './helpers.js';

describe('wipe all data', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    await me.post('/api/clients', { name: 'Bayview Guesthouse' });
    const inv = await me.post('/api/documents', { kind: 'invoice', issueDate: '2026-10-05', lines: [{ category: 'labour', description: 'Install', qty: 1, unitPriceCents: 100000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
  });
  afterAll(() => env.close());

  it('asks for the business’s name and the owner’s password', async () => {
    const { names } = await me.get('/api/wipe');
    expect(names.length).toBeGreaterThan(0);
    const wrongPw = await me.call({ method: 'POST', url: '/api/wipe', payload: { password: 'not-it', name: names[0] } });
    expect(wrongPw.statusCode).toBe(400);
    const wrongName = await me.call({ method: 'POST', url: '/api/wipe', payload: { password: 'test-password-1', name: 'Someone else' } });
    expect(wrongName.statusCode).toBe(400);
    expect(await me.get('/api/documents?kind=invoice')).toHaveLength(1);
    const site = await login(env.app, 'site@example.co.za');
    expect((await site.call({ method: 'POST', url: '/api/wipe', payload: { password: 'test-password-1', name: names[0] } })).statusCode).toBe(403);
  });

  it('wipes the books but keeps who signs in', async () => {
    const { names } = await me.get('/api/wipe');
    const r = await me.call({ method: 'POST', url: '/api/wipe', payload: { password: 'test-password-1', name: names[0].toUpperCase() } });
    expect(r.statusCode).toBe(200);
    // The same session still works, and so does signing in again.
    expect(await me.get('/api/documents?kind=invoice')).toHaveLength(0);
    expect(await me.get('/api/clients')).toHaveLength(0);
    const again = await login(env.app, 'owner@example.co.za');
    const { settings, accounts } = await again.get('/api/reference');
    expect(settings.setupDone).toBe(false);
    expect(accounts.length).toBeGreaterThan(10);
    const [row] = await env.sql`select count(*)::int as n from audit_log where action = 'wipe_all_data'`;
    expect(row!.n).toBe(1);
    // The books work again straight away.
    const inv = await again.post('/api/documents', { kind: 'invoice', issueDate: '2026-11-01', lines: [{ category: 'labour', description: 'Fresh start', qty: 1, unitPriceCents: 5000 }] });
    expect(inv.number).toBeTruthy();
  });
});
