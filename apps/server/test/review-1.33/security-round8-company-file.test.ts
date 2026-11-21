/**
 * The eighth round of 1.33's reviews (security and privacy): the company file now holds names to Settings' limits (an
 * account's name to 120 characters), but Shap itself names accounts longer than that: a partner's
 * current account is "Current account: " and the partner's name (up to 120). A partnership's own
 * company file, downloaded from Shap, is then refused when it's loaded back. Made-up partner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

describe('a partnership’s own company file, with a partner’s long name', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('loads back as Shap made it', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, businessType: 'partnership' }, 'PUT');
    // 110 characters: Settings takes up to 120 for a partner.
    const name = 'Made-up Partner ' + 'Abcdefghij'.repeat(9) + 'Klmn';
    expect(name.length).toBe(110);
    const res0 = await owner.call({ method: 'POST', url: '/api/partners', payload: { name, shareBp: 10000 } });
    expect(res0.statusCode, res0.body).toBe(200);
    const { url } = await owner.post('/api/company-file/link', { password: 'test-password-1' });
    const file = (await owner.call({ method: 'GET', url })).json();
    expect(file.accounts.some((a: { name: string }) => a.name.length > 120)).toBe(true);
    const res = await owner.call({ method: 'POST', url: '/api/company-file', payload: { file, password: 'test-password-1' } });
    expect(res.statusCode, res.body).toBe(200);
  });
});
