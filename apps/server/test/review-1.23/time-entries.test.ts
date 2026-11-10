/**
 * From the independent review of 1.23 (it failed before the fix): "Track time on jobs" let a member
 * of staff see everyone's time with the jobs' billing rates, and change or delete anyone's, the
 * owner's included. Now each person keeps to their own, and the rate is for those who see what
 * jobs make. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionFor, setup, type TestEnv } from '../helpers.js';

describe('time on jobs, between people', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof sessionFor>>;
  let job: { id: string };
  beforeAll(async () => {
    env = await setup();
    owner = await sessionFor(env, 'owner@example.co.za');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, features: { ...settings.features, jobs: true, timeTracker: true } }, 'PUT');
    job = await owner.post('/api/projects', { name: 'Fictional kitchen', status: 'active', hourlyRateCents: 85_000 });
    await owner.post('/api/users', { name: 'Timer (made up)', email: 'timer@example.co.za', role: 'staff', profileId: null, access: ['time.track'], password: 'test-password-1' });
  });
  afterAll(() => env.close());

  it('keeps each person to their own time, and the rates to those who see the money', async () => {
    const mine = await owner.post('/api/time', { projectId: job.id, startedAt: '2026-07-01T08:00:00Z', endedAt: '2026-07-01T16:00:00Z', note: 'Owner’s day (made up)' });
    const timer = await sessionFor(env, 'timer@example.co.za');
    const theirs = await timer.post('/api/time', { projectId: job.id, startedAt: '2026-07-02T08:00:00Z', endedAt: '2026-07-02T12:00:00Z', note: 'Timer’s morning (made up)' });
    const list = await timer.get('/api/time');
    expect(list.entries.map((e: { note: string }) => e.note)).toEqual(['Timer’s morning (made up)']);
    expect(list.entries.map((e: { hourlyRateCents?: number | null }) => e.hourlyRateCents ?? null)).toEqual([null]);
    // Not the owner's to change or delete.
    const put = await timer.call({ method: 'PUT', url: `/api/time/${mine.id}`, payload: { projectId: job.id, startedAt: '2026-07-01T08:00:00Z', endedAt: '2026-07-01T09:00:00Z', note: 'changed' } });
    expect(put.statusCode).toBe(400);
    expect((await timer.call({ method: 'DELETE', url: `/api/time/${mine.id}` })).statusCode).toBe(404);
    // Their own, yes.
    expect((await timer.call({ method: 'PUT', url: `/api/time/${theirs.id}`, payload: { projectId: job.id, startedAt: '2026-07-02T08:00:00Z', endedAt: '2026-07-02T11:00:00Z', note: 'Timer’s morning (made up)' } })).statusCode).toBe(200);
    // The owner still sees everyone's, with the rate.
    const all = await owner.get('/api/time');
    expect(all.entries.map((e: { note: string }) => e.note).sort()).toEqual(['Owner’s day (made up)', 'Timer’s morning (made up)']);
    expect(Number(all.entries[0].hourlyRateCents)).toBe(85_000);
    expect((await owner.get('/api/time')).entries.find((e: { id: string }) => e.id === mine.id).minutes).toBe(480);
  });
});
