/** Fitting the app to the kind of business: examples, cost types, usual items; and the quieter extras. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { industryProfile, lineLabel } from '@shap/shared';
import { login, setup, type TestEnv } from './helpers.js';

describe('a hairdresser’s books', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Thandi’s Hair Studio', setupDone: true, industry: 'hair' }, 'PUT');
  });
  afterAll(() => env.close());

  it('calls things what a salon calls them', () => {
    expect(lineLabel('hair', 'labour')).toBe('Services');
    expect(lineLabel('hair', 'materials')).toBe('Products');
    expect(lineLabel('design', 'labour')).toBe('Design');
    expect(lineLabel('', 'labour')).toBe('Labour');
    expect(industryProfile('hair').costStock).not.toMatch(/cement/i);
    expect(industryProfile('design').items.map((i) => i.d)).toContain('Logo design (3 concepts)');
  });

  it('adds a salon’s cost types, first in the list, and puts the builder’s away', async () => {
    const { categories } = await me.get('/api/reference');
    const names = categories.filter((c: { active: boolean }) => c.active).map((c: { name: string }) => c.name);
    expect(names.slice(0, 4)).toEqual(['Salon products & stock', 'Chair or salon rent', 'Training & courses', 'Laundry & towels']);
    expect(names).not.toContain('Demo');
    expect(names).not.toContain('PPE');
    const rent = categories.find((c: { name: string }) => c.name === 'Chair or salon rent');
    expect(rent.accountCode).toBe('6200');
  });

  it('switching to a builder brings the building cost types back, and only adds each type once', async () => {
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, industry: 'builder' }, 'PUT');
    await me.post('/api/settings', { ...settings, industry: 'hair' }, 'PUT');
    await me.post('/api/settings', { ...settings, industry: 'builder' }, 'PUT');
    const { categories } = await me.get('/api/reference');
    const active = categories.filter((c: { active: boolean }) => c.active).map((c: { name: string }) => c.name);
    expect(active).toContain('Demo');
    expect(categories.filter((c: { name: string }) => c.name === 'Salon products & stock')).toHaveLength(1);
    await me.post('/api/settings', { ...settings, industry: 'hair' }, 'PUT');
  });

  it('invoices a walk-in with no name, and the name can be added later', async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', issueDate: '2026-11-02', lines: [{ category: 'labour', description: 'Cut and blow-dry', qty: 1, unitPriceCents: 35000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    const pdf = await me.call({ method: 'GET', url: `/api/documents/${inv.id}/pdf` });
    expect(pdf.statusCode).toBe(200);
    const client = await me.post('/api/clients', { name: 'Lerato M' });
    const d = await me.get(`/api/documents/${inv.id}`);
    await me.post(`/api/documents/${inv.id}`, { ...d.doc, clientId: client.id, lines: d.lines }, 'PUT');
    expect((await me.get(`/api/documents/${inv.id}`)).doc.clientName).toBe('Lerato M');
  });

  it('offers the usual items with last time’s price, most used first', async () => {
    for (const [desc, cents, date] of [['Root colour', 60000, '2026-10-01'], ['Root colour', 65000, '2026-10-20'], ['Toner', 30000, '2026-10-05']] as const) {
      await me.post('/api/documents', { kind: 'invoice', issueDate: date, lines: [{ category: 'labour', description: desc, qty: 1, unitPriceCents: cents }] });
    }
    const usual = await me.get('/api/documents/usual-lines');
    expect(usual[0]).toMatchObject({ description: 'Root colour', unitPriceCents: 65000, uses: 2, category: 'labour' });
    expect(usual.map((u: { description: string }) => u.description)).toContain('Toner');
  });

  it('signs off PDFs with the Shap line unless it’s switched off', async () => {
    const inv = await me.post('/api/documents', { kind: 'quote', issueDate: '2026-11-02', lines: [{ category: 'labour', description: 'Balayage', qty: 1, unitPriceCents: 120000 }] });
    const size = async () => (await me.call({ method: 'GET', url: `/api/documents/${inv.id}/pdf` })).rawPayload.length;
    const { settings } = await me.get('/api/reference');
    expect(settings.watermark).toBe(true);
    const withLine = await size();
    await me.post('/api/settings', { ...settings, watermark: false }, 'PUT');
    const without = await size();
    expect(withLine).toBeGreaterThan(without + 200);
  });
});
