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
});
