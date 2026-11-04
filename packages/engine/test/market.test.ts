/** Anonymous market rates on the phone: nothing until the owner has been told, then last month once. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lastWholeMonth } from '@shap/shared';
import { today } from '../src/lib/books.js';
import { login, setup, type TestEnv } from './helpers.js';

describe('sharing market rates from the phone', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  const month = lastWholeMonth(today());
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    await env.sql`update settings set industry = 'electrician', setup_done = true where id`;
    for (const price of [60000, 70000]) {
      const doc = await owner.post('/api/documents', { kind: 'invoice', issueDate: `${month}-12`, lines: [{ description: 'Install plug point', unit: 'point', qty: 3, unitPriceCents: price }, { description: 'Plug points at the Botha house', unit: 'point', qty: 2, unitPriceCents: 99000 }] });
      await env.sql`update documents set status = 'issued' where id = ${doc.id}`;
    }
  });
  afterAll(() => env.close());

  it('is on, but has nothing to share until the owner has been told', async () => {
    expect((await owner.get('/api/reference')).settings).toMatchObject({ marketConsent: true, marketNoticeSeen: false });
    expect((await owner.get('/api/market/share')).share).toBeNull();
  });

  it('offers last month’s standard items only, then nothing once it’s gone', async () => {
    await env.sql`update settings set market_notice_seen = true where id`;
    const { share } = await owner.get('/api/market/share');
    expect(share).toMatchObject({ month, industry: 'electrician', rates: [{ item: 'Install plug point', unit: 'point', cents: 65000 }] });
    expect(JSON.stringify(share)).not.toMatch(/Botha/);
    await owner.post('/api/market/sent', { month });
    expect((await owner.get('/api/market/share')).share).toBeNull();
  });

  it('offers nothing once switched off', async () => {
    await env.sql`update settings set market_consent = false, market_sent_month = '' where id`;
    expect((await owner.get('/api/market/share')).share).toBeNull();
  });
});
