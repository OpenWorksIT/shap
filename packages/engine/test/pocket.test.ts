/** What's particular to Shap Pocket: a new phone's books, switches, sharing. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup, type TestEnv } from './helpers.js';

describe('a new phone', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup({ fresh: true });
    me = await login(env.app);
  });
  afterAll(() => env.close());

  it('starts as one person trading in their own name, waiting for the first-run questions', async () => {
    const { settings, accounts } = await me.get('/api/reference');
    expect(settings).toMatchObject({ businessType: 'sole_prop', fyEndMonth: 2, setupDone: false, companyName: '', features: {} });
    expect(accounts.find((a: { systemKey: string }) => a.systemKey === 'owner_loan')).toMatchObject({ name: 'Owner’s capital and drawings', type: 'equity' });
  });

  it('saves the answers, the switches and where the logo sits', async () => {
    const { settings } = await me.get('/api/reference');
    const saved = await me.post('/api/settings', { ...settings, companyName: 'Sparky Electrical', setupDone: true, features: { workers: false, jobs: true }, logoLayout: { zoom: 1.4, x: 0.1, y: -0.05 } }, 'PUT');
    expect(saved).toMatchObject({ companyName: 'Sparky Electrical', setupDone: true, features: { workers: false, jobs: true }, logoLayout: { zoom: 1.4, x: 0.1, y: -0.05 } });
  });

  it('marks a quote sent when it’s shared from the phone', async () => {
    const q = await me.post('/api/documents', { kind: 'quote', issueDate: '2026-11-01', lines: [{ category: 'labour', description: 'Install DB board', qty: 1, unitPriceCents: 450000 }] });
    await me.post(`/api/documents/${q.id}/shared`);
    const d = await me.get(`/api/documents/${q.id}`);
    expect(d.doc.status).toBe('sent');
    expect(d.doc.sentAt).toBeTruthy();
    const pdf = await me.call({ method: 'GET', url: `/api/documents/${q.id}/pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(new TextDecoder().decode(pdf.rawPayload.subarray(0, 5))).toBe('%PDF-');
    // One name on the door: no placeholder trading name in the file name.
    expect(pdf.headers['content-disposition']).toContain('filename="Quote ');
    expect((await me.get('/api/reference')).brands).toHaveLength(0);
  });

  it('prints a card payment link on unpaid invoices', async () => {
    const { settings } = await me.get('/api/reference');
    const bad = await me.call({ method: 'PUT', url: '/api/settings', payload: { ...settings, payLink: 'pay.yoco.com/x' } });
    expect(bad.statusCode).toBe(400);
    await me.post('/api/settings', { ...settings, payLink: 'https://pay.yoco.com/sparky' }, 'PUT');
    const inv = await me.post('/api/documents', { kind: 'invoice', issueDate: '2026-11-01', payLink: 'https://pay.yoco.com/r/abc123', lines: [{ category: 'labour', description: 'Call-out', qty: 1, unitPriceCents: 85000 }] });
    expect((await me.get(`/api/documents/${inv.id}`)).doc.payLink).toBe('https://pay.yoco.com/r/abc123');
    const text = async () => new TextDecoder('latin1').decode((await me.call({ method: 'GET', url: `/api/documents/${inv.id}/pdf` })).rawPayload);
    // A draft isn't issued, so its PDF asks for no payment (1.10.2); issued, it carries the link.
    expect(await text()).not.toContain('https://pay.yoco.com/r/abc123');
    await me.post(`/api/documents/${inv.id}/issue`, {});
    expect(await text()).toContain('https://pay.yoco.com/r/abc123'); // the link annotation
  });

  it('has no sign-in, users, demo, email or server routes', () => {
    const paths = env.app.list().map((r) => r.path);
    for (const gone of ['/api/auth/login', '/api/users', '/api/demo', '/api/system', '/api/documents/:id/email', '/api/monthly-invoices']) {
      expect(paths.some((p) => p.startsWith(gone))).toBe(false);
    }
  });
});
