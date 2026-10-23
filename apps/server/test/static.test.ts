import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

const dist = resolve(__dirname, '../../web/dist');

// Needs the web app built (npm run build).
describe.skipIf(!existsSync(resolve(dist, 'index.html')))('serving the app', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ env: { WEB_DIST: dist } });
  });
  afterAll(() => env.close());

  it('always rechecks the shell and service worker, so an update shows without a hard refresh', async () => {
    for (const url of ['/', '/sw.js', '/costs']) {
      const r = await env.app.inject({ url });
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-cache');
      // Only Shap's own scripts run, and it can't be framed by another site.
      expect(String(r.headers['content-security-policy'])).toMatch(/script-src 'self'.*frame-ancestors 'none'/);
    }
  });
});
