/**
 * From the independent review of 1.23 (it failed before the fix): the jobs were open to anyone
 * signed in, so a teller (or someone with nothing ticked) read every job with its client, the site
 * address and the notes. A job now takes "See jobs"; the list to pick from is for those who log,
 * capture or invoice against one. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionFor, setup, type TestEnv } from '../helpers.js';

describe('the jobs, for staff who aren’t given them', () => {
  let env: TestEnv;
  let job: { id: string };
  beforeAll(async () => {
    env = await setup();
    const owner = await sessionFor(env, 'owner@example.co.za');
    const client = await owner.post('/api/clients', { name: 'Fictional Homeowner', address: '9 Private Lane, Fictional Town' });
    job = await owner.post('/api/projects', { name: 'Fictional bathroom', clientId: client.id, status: 'active', siteAddress: '9 Private Lane, Fictional Town', notes: 'Gate code 1234 (made up)' });
    const teller = (await owner.get('/api/profiles')).find((p: { name: string }) => p.name === 'Teller');
    await owner.post('/api/users', { name: 'Teller (made up)', email: 'teller@example.co.za', role: 'staff', profileId: teller.id, password: 'test-password-1' });
    await owner.post('/api/users', { name: 'Nothing (made up)', email: 'nothing@example.co.za', role: 'staff', profileId: null, access: [], password: 'test-password-1' });
    await owner.post('/api/users', { name: 'Slips (made up)', email: 'slips@example.co.za', role: 'staff', profileId: null, access: ['costs.capture'], password: 'test-password-1' });
  });
  afterAll(() => env.close());

  it('keeps a job’s address and notes from someone without “See jobs”', async () => {
    for (const email of ['teller@example.co.za', 'nothing@example.co.za']) {
      const who = await sessionFor(env, email);
      expect((await who.call({ method: 'GET', url: `/api/projects/${job.id}` })).statusCode, email).toBe(403);
      expect((await who.call({ method: 'GET', url: '/api/projects' })).statusCode, email).toBe(403);
    }
  });

  it('lets someone capturing slips pick the job by name, and no more', async () => {
    const slips = await sessionFor(env, 'slips@example.co.za');
    expect(await slips.get('/api/projects?status=open')).toEqual([expect.objectContaining({ id: job.id, name: 'Fictional bathroom' })]);
    expect(Object.keys((await slips.get('/api/projects'))[0]).sort()).toEqual(['clientName', 'id', 'name', 'number', 'status']);
    expect((await slips.call({ method: 'GET', url: `/api/projects/${job.id}` })).statusCode).toBe(403);
  });
});
