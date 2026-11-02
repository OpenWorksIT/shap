/** Several people at once: an open screen hears when someone else saves. */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appVersion } from '../src/modules/system.js';
import { setup, type TestEnv } from './helpers.js';

describe('live updates', () => {
  let env: TestEnv;
  let base = '';
  beforeAll(async () => {
    env = await setup();
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(env.app.server.address() as AddressInfo).port}`;
  });
  afterAll(() => env.close());

  const signIn = async (email: string) => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shap-version': appVersion() }, body: JSON.stringify({ email, password: 'test-password-1' }) });
    return r.headers.get('set-cookie')!.split(';')[0]!;
  };

  it('tells the owner’s screen when the site team logs something, but not about their own saves', async () => {
    const owner = await signIn('owner@example.co.za');
    const site = await signIn('site@example.co.za');
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/live`, { headers: { cookie: owner }, signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let got = '';
    const read = (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: '', done: true }));
        if (done) return;
        got += value;
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    const h = (cookie: string) => ({ cookie, 'content-type': 'application/json', 'x-shap-version': appVersion() });
    // The owner's own save isn't echoed back to them.
    await fetch(`${base}/api/clients`, { method: 'POST', headers: h(owner), body: JSON.stringify({ name: 'Mine' }) });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).not.toContain('event: changed');
    // Someone else's is.
    const worker = await fetch(`${base}/api/workers`, { method: 'POST', headers: h(owner), body: JSON.stringify({ name: 'Sipho', dayRateCents: 45000 }) }).then((r) => r.json());
    got = '';
    const r = await fetch(`${base}/api/labour`, { method: 'POST', headers: h(site), body: JSON.stringify({ date: '2026-11-02', entries: [{ workerId: worker.id, days: 1, wageCents: 45000 }], workTypeId: (await env.sql<{ id: string }[]>`select id from work_types limit 1`)[0]!.id }) });
    expect(r.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toContain('event: changed');
    ctrl.abort();
    await read;
  });
});
