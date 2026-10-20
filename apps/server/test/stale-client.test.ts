import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appVersion } from '../src/modules/system.js';
import { login, setup, type TestEnv } from './helpers.js';

describe('a page opened before an update', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
  });
  afterAll(() => env.close());

  it('is told the server’s version on every reply', async () => {
    const r = await owner.call({ method: 'GET', url: '/api/health' });
    expect(r.headers['x-shap-version']).toBe(appVersion());
  });

  it('can still read, but can’t change anything until it reloads', async () => {
    const old = { 'x-shap-version': '0.0.1', 'x-shap-client': 'web' };
    expect((await owner.call({ method: 'GET', url: '/api/costs', headers: old })).statusCode).toBe(200);
    const r = await owner.call({ method: 'POST', url: '/api/clients', payload: { name: 'Stale Co' }, headers: old });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'stale_client' });
    const ok = await owner.call({ method: 'POST', url: '/api/clients', payload: { name: 'Fresh Co' }, headers: { 'x-shap-version': appVersion() } });
    expect(ok.statusCode).toBe(200);
    // A page from before versions were sent at all.
    const ancient = await env.app.inject({ method: 'POST', url: '/api/clients', payload: { name: 'Old Co' }, cookies: { shap_session: (await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.co.za', password: 'test-password-1' } })).cookies.find((c) => c.name === 'shap_session')!.value } });
    expect(ancient.statusCode).toBe(409);
    // The phone app ships its own screens and isn't reloaded this way.
    const native = await owner.call({ method: 'POST', url: '/api/clients', payload: { name: 'Phone Co' }, headers: { 'x-shap-version': '0.0.1', 'x-shap-client': 'native' } });
    expect(native.statusCode).toBe(200);
  });
});
