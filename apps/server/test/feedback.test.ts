/** Feedback from Shap's screens, and the collector that hears from Shap Pocket. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup, type TestEnv } from './helpers.js';

const report = (over: Record<string, unknown> = {}) => ({ kind: 'bug', message: 'The total looks wrong', page: '/documents/x', title: 'Shap', at: new Date().toISOString(), ...over });

describe('feedback and the collector', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ env: { FEEDBACK_DIR: mkdtempSync(join(tmpdir(), 'shap-fb-')), COLLECT: 'true' } });
  });
  afterAll(() => env.close());

  it('takes feedback from anyone signed in, and the owner reads it', async () => {
    const site = await login(env.app, 'site@example.co.za');
    const r = await site.post('/api/feedback', report({ kind: 'dislike', message: 'Too many taps to log a day' }));
    expect(r.id).toMatch(/^FB-/);
    const owner = await login(env.app, 'owner@example.co.za');
    const list = await owner.get('/api/feedback');
    expect(list[0]).toMatchObject({ source: 'here', who: 'Site (capture)', kind: 'dislike' });
    expect((await site.call({ method: 'GET', url: '/api/feedback' })).statusCode).toBe(403);
  });

  it('collects from Shap Pocket without an account, with CORS', async () => {
    const pre = await env.app.inject({ method: 'OPTIONS', url: '/collect/feedback', headers: { origin: 'capacitor://localhost' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    const r = await env.app.inject({ method: 'POST', url: '/collect/feedback', payload: { ...report(), app: 'pocket', version: '1.0.0', platform: 'ios' } });
    expect(r.statusCode).toBe(201);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.cookies).toHaveLength(0);
    const owner = await login(env.app, 'owner@example.co.za');
    const list = await owner.get('/api/feedback');
    expect(list[0]).toMatchObject({ source: 'pocket', who: 'Shap Pocket 1.0.0 (ios)' });
    // Words are needed for a bug report; junk is refused.
    expect((await env.app.inject({ method: 'POST', url: '/collect/feedback', payload: { ...report({ message: '' }), app: 'pocket' } })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'POST', url: '/collect/feedback', payload: { ...report(), app: 'pocket', screenshot: 'data:image/png;base64,AAAA' } })).statusCode).toBe(400);
  });

  it('counts anonymous usage notes, one per set of books', async () => {
    const note = { app: 'pocket', version: '1.0.0', installId: '0b8f8c2e-4a7b-4c1e-9d3f-2a6b5c4d3e21', platform: 'android', businessType: 'sole_prop', industry: 'hair', features: ['quotes', 'bank'], vatRegistered: false, tone: 'casual' };
    expect((await env.app.inject({ method: 'POST', url: '/collect/usage', payload: note })).statusCode).toBe(201);
    // The same phone again (changed its mind about quotes): still one.
    expect((await env.app.inject({ method: 'POST', url: '/collect/usage', payload: { ...note, features: ['bank'] } })).statusCode).toBe(201);
    expect((await env.app.inject({ method: 'POST', url: '/collect/usage', payload: { ...note, installId: 'not-an-id' } })).statusCode).toBe(400);
    const owner = await login(env.app, 'owner@example.co.za');
    // This Shap's own note, when its owner agrees.
    const s = (await owner.get('/api/reference')).settings;
    await owner.post('/api/settings', { ...s, industry: 'builder', usageConsent: true, lockDate: s.lockDate ?? null }, 'PUT');
    await new Promise((r) => setTimeout(r, 200));
    const u = await owner.get('/api/feedback/usage');
    expect(u).toMatchObject({ collecting: true, total: 2 });
    expect(u.byIndustry.map((x: { name: string }) => x.name).sort()).toEqual(['builder', 'hair']);
    // The phone's second note replaced its first: only this Shap still counts quotes.
    expect(u.byFeature.find((x: { name: string }) => x.name === 'quotes').n).toBe(1);
  });

  it('remembers when an install was first heard from and when it updated', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = join(env.ctx.config.FEEDBACK_DIR, 'usage');
    const note = { app: 'pocket', version: '1.0.0', installId: '6d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6', platform: 'android', businessType: 'sole_prop', industry: 'it', features: [], vatRegistered: false, tone: 'casual' };
    const read = () => readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))).find((n) => n.industry === 'it');
    await env.app.inject({ method: 'POST', url: '/collect/usage', payload: note });
    const first = read();
    expect(first.firstAt).toBe(first.at);
    expect(first.updatedAt).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    await env.app.inject({ method: 'POST', url: '/collect/usage', payload: { ...note, version: '1.0.1' } });
    const after = read();
    expect(after).toMatchObject({ version: '1.0.1', previousVersion: '1.0.0', firstAt: first.firstAt });
    expect(after.updatedAt).toBe(after.at);
    // A monthly check-in on the same version keeps the update as it was.
    await new Promise((r) => setTimeout(r, 20));
    await env.app.inject({ method: 'POST', url: '/collect/usage', payload: { ...note, version: '1.0.1' } });
    expect(read()).toMatchObject({ updatedAt: after.updatedAt, previousVersion: '1.0.0' });
  });

  it('sends this Shap’s own note only when it changed or a month has passed', async () => {
    const { checkInUsage } = await import('../src/modules/feedback.js');
    const at = async () => (await env.sql<{ t: Date | null }[]>`select usage_sent_at as t from settings where id`)[0]!.t;
    await env.sql`update settings set setup_done = true, usage_consent = true where id`;
    await checkInUsage(env.ctx, env.sql, { warn: () => {} });
    const sent = await at();
    expect(sent).toBeTruthy();
    await checkInUsage(env.ctx, env.sql, { warn: () => {} });
    expect((await at())!.getTime()).toBe(sent!.getTime());
    // A month on, it checks in again.
    await env.sql`update settings set usage_sent_at = now() - interval '31 days' where id`;
    await checkInUsage(env.ctx, env.sql, { warn: () => {} });
    expect((await at())!.getTime()).toBeGreaterThan(sent!.getTime());
  });

  it('takes ideas, and forgets reports and usage notes after a year', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/collect/feedback', payload: { ...report({ kind: 'idea', message: 'Please add tattoo artists' }), app: 'pocket', version: '0.6.0', platform: 'android' } });
    expect(r.statusCode).toBe(201);
    const owner = await login(env.app, 'owner@example.co.za');
    expect((await owner.get('/api/feedback'))[0]).toMatchObject({ kind: 'idea' });
    const prune = (env.app as unknown as { pruneFeedback: (now?: number) => Promise<number> }).pruneFeedback;
    expect(await prune()).toBe(0);
    const before = (await owner.get('/api/feedback')).length;
    expect(before).toBeGreaterThan(0);
    expect(await prune(Date.now() + 366 * 86_400_000)).toBe(before);
    expect(await owner.get('/api/feedback')).toHaveLength(0);
    expect((await owner.get('/api/feedback/usage')).total).toBe(0);
  });
});
