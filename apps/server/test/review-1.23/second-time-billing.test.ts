/**
 * From the second review of 1.23, of the fixes (it failed before this fix): with time kept to each person's own, someone who makes the
 * invoices (and tracks time) can no longer put a colleague's time on the client's invoice: the
 * invoice's "Add time" list (GET /api/time?unbilled=1) shows only their own, and billing a
 * colleague's entries is refused. Only the owner can bill other people's time. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectCleanAudit, sessionFor, setup, type TestEnv } from '../helpers.js';

describe('billing a colleague’s time', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof sessionFor>>;
  let job: { id: string };
  beforeAll(async () => {
    env = await setup();
    owner = await sessionFor(env, 'owner@example.co.za');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, features: { ...settings.features, jobs: true, timeTracker: true } }, 'PUT');
    job = await owner.post('/api/projects', { name: 'Fictional kitchen', status: 'active', hourlyRateCents: 85_000 });
    await owner.post('/api/users', { name: 'Tech (made up)', email: 'tech@example.co.za', role: 'staff', profileId: null, access: ['time.track'], password: 'test-password-1' });
    await owner.post('/api/users', { name: 'Invoicer (made up)', email: 'invoicer@example.co.za', role: 'staff', profileId: null, access: ['time.track', 'documents.edit'], password: 'test-password-1' });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('lets whoever makes the invoices bill the time worked on the job', async () => {
    const tech = await sessionFor(env, 'tech@example.co.za');
    const t = await tech.post('/api/time', { projectId: job.id, startedAt: '2026-07-02T08:00:00Z', endedAt: '2026-07-02T12:00:00Z', note: 'Tech’s morning (made up)' });
    const invoicer = await sessionFor(env, 'invoicer@example.co.za');
    const client = await owner.post('/api/clients', { name: 'Fictional Client' });
    const inv = await invoicer.post('/api/documents', { kind: 'invoice', clientId: client.id, projectId: job.id, issueDate: '2026-07-03', lines: [] });
    const unbilled = await invoicer.get('/api/time?unbilled=1');
    expect(unbilled.entries.map((e: { id: string }) => e.id)).toContain(t.id);
    const billed = await invoicer.call({ method: 'POST', url: '/api/time/bill', payload: { documentId: inv.id, ids: [t.id] } });
    expect(billed.statusCode, billed.body).toBe(200);
  });
});
