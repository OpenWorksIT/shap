/**
 * From the five reviews of Pocket 1.10.1 (Send works again), fixed in 1.10.2 (each failed before):
 * a draft invoice or credit note isn't issued, so its PDF no longer says "Tax invoice" or asks to be
 * paid; what the message calls a document is what its PDF calls it, from the document's own VAT
 * rate, not today's settings; and a draft shared from the phone counts as gone out, for the warning
 * before it's deleted. From the check of those fixes: a voided invoice asked to be paid too, and the
 * message's payment lines are tested where they're made. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentHeading, documentName, hasGoneOut, notIssuedYet, shareMessage } from '@shap/shared';
import { expectCleanAudit, login, setup, type TestEnv } from './helpers.js';

const D = '2026-11-10';
const pdfText = async (buf: Uint8Array) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let out = '';
  for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  return out.replace(/\s+/g, ' ');
};

describe('Send, from the 1.10.1 reviews', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let client: { id: string };
  const line = { category: 'labour', description: 'Made-up call-out', qty: 1, unitPriceCents: 85_000 };
  const pdf = async (id: string) => {
    const r = await me.call({ method: 'GET', url: `/api/documents/${id}/pdf` });
    expect(r.statusCode).toBe(200);
    return { name: /filename="([^"]+)"/.exec(String(r.headers['content-disposition']))![1]!, text: await pdfText(r.rawPayload) };
  };
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings } = await me.get('/api/reference');
    await me.post(
      '/api/settings',
      { ...settings, companyName: 'Fictional Sparks', vatRegistered: true, vatNumber: '4740101508', bankDetails: 'Made-up Bank, account 000 000 000', payLink: 'https://pay.example.com/made-up', features: { ...settings.features, creditNotes: true } },
      'PUT',
    );
    client = await me.post('/api/clients', { name: 'Pretend Client (Pty) Ltd', address: '5 Pretend Road, Fictional Town' });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql, '2026-11-30');
    await env.close();
  });

  it('heads a draft invoice “Draft invoice”, asking for no payment, and the issued one “Tax invoice”', async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [line] });
    const draft = await pdf(inv.id);
    expect(draft.name).toContain('Draft invoice ');
    expect(draft.text).toContain('Draft invoice');
    expect(draft.text).not.toMatch(/Tax invoice|AMOUNT DUE|Made-up Bank|pay\.example\.com/);
    await me.post(`/api/documents/${inv.id}/issue`, {});
    const issued = await pdf(inv.id);
    expect(issued.name).toContain('Tax invoice ');
    expect(issued.text).toContain('Tax invoice');
    expect(issued.text).toContain('AMOUNT DUE');
    expect(issued.text).toContain('Made-up Bank');
    const { doc } = await me.get(`/api/documents/${inv.id}`);
    expect([notIssuedYet(doc), documentName(doc), documentHeading(doc)]).toEqual([false, 'Tax invoice', 'Tax invoice']);
  });

  it('heads a draft credit note “Draft credit note”, not yet credited', async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [line] });
    await me.post(`/api/documents/${inv.id}/issue`, {});
    const cn = await me.post(`/api/documents/${inv.id}/credit-note`, { issueDate: D, creditReason: 'Made-up return' });
    const draft = await pdf(cn.id);
    expect(draft.name).toContain('Draft credit note ');
    expect(draft.text).toContain('Draft credit note');
    expect(draft.text).toContain('TO CREDIT');
    expect(draft.text).not.toContain('CREDITED');
  });

  it('names a document as its PDF does, from its own VAT rate, not whether the business is registered today', async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [line] });
    await me.post(`/api/documents/${inv.id}/issue`, {});
    // Deregistered since (made up): the invoice was a tax invoice and stays one; the message used
    // to call it an "invoice" from today's settings.
    await env.sql`update settings set vat_registered = false`;
    const { doc } = await me.get(`/api/documents/${inv.id}`);
    expect(documentName(doc)).toBe('Tax invoice');
    expect((await pdf(inv.id)).name).toContain(`${documentName(doc)} `);
    // And the other way round: one from before registering (no VAT on it) is a plain invoice.
    expect(documentName({ ...doc, vatRateBp: 0 })).toBe('Invoice');
    expect(documentName({ ...doc, vatRateBp: 0, legacySale: true })).toBe('Sale');
    expect(documentName({ kind: 'quote', status: 'draft', vatRateBp: 1500 })).toBe('Quote');
    expect(documentHeading({ kind: 'quote', status: 'draft', vatRateBp: 1500 })).toBe('Quotation');
    expect(documentName({ kind: 'quote', status: 'draft', vatRateBp: 1500, proforma: true })).toBe('Pro-forma invoice');
    await env.sql`update settings set vat_registered = true`;
  });

  it('asks no payment on a voided invoice', async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [line] });
    await me.post(`/api/documents/${inv.id}/issue`, {});
    await me.post(`/api/documents/${inv.id}/void`, { reason: 'Made-up mistake' });
    const voided = await pdf(inv.id);
    expect(voided.text).toContain('VOID');
    expect(voided.text).not.toMatch(/AMOUNT DUE|Made-up Bank|pay\.example\.com/);
    const { doc } = await me.get(`/api/documents/${inv.id}`);
    expect(shareMessage(doc, { from: 'Fictional Sparks', payLink: 'https://pay.example.com/made-up', payshapId: '0820000000' })).not.toMatch(/PayShap|Pay by card/);
  });

  it('asks to be paid in the message only where the PDF does, naming it as the PDF does', async () => {
    const opts = { from: 'Fictional Sparks', payLink: 'https://pay.example.com/made-up', payshapId: '0820000000' };
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [line] });
    const draft = shareMessage((await me.get(`/api/documents/${inv.id}`)).doc, opts);
    expect(draft).toContain(`Please find draft invoice ${inv.number} attached.`);
    expect(draft).not.toMatch(/PayShap|Pay by card/);
    await me.post(`/api/documents/${inv.id}/issue`, {});
    const issued = shareMessage((await me.get(`/api/documents/${inv.id}`)).doc, opts);
    expect(issued).toContain(`Please find tax invoice ${inv.number} attached.`);
    expect(issued).toContain(`Pay instantly with PayShap to 0820000000 (reference ${inv.number}).`);
    expect(issued).toContain('Pay by card: https://pay.example.com/made-up');
    expect(issued).toMatch(/Kind regards,\nFictional Sparks$/);
    // Deregistered since (made up): still a tax invoice, as its PDF says; it used to go by today's settings.
    await env.sql`update settings set vat_registered = false`;
    expect(shareMessage((await me.get(`/api/documents/${inv.id}`)).doc, opts)).toContain('Please find tax invoice');
    await env.sql`update settings set vat_registered = true`;
    // PayShap only when it's switched on (the screen passes no id otherwise).
    expect(shareMessage((await me.get(`/api/documents/${inv.id}`)).doc, { ...opts, payshapId: '' })).not.toContain('PayShap');
    // A pro-forma asks to be paid, a quote doesn't.
    const pf = await me.post('/api/documents', { kind: 'quote', proforma: true, clientId: client.id, issueDate: D, lines: [line] });
    expect(shareMessage((await me.get(`/api/documents/${pf.id}`)).doc, opts)).toContain('Pay by card');
    const q = await me.post('/api/documents', { kind: 'quote', clientId: client.id, issueDate: D, lines: [line] });
    expect(shareMessage((await me.get(`/api/documents/${q.id}`)).doc, opts)).toMatch(/^Good day Pretend Client \(Pty\) Ltd,\n\nPlease find quote \S+ attached\.\n\nKind regards/);
  });

  it('counts a draft invoice shared from the phone as gone out, still a draft', async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [line] });
    expect(hasGoneOut((await me.get(`/api/documents/${inv.id}`)).doc)).toBe(false);
    await me.post(`/api/documents/${inv.id}/shared`);
    const { doc } = await me.get(`/api/documents/${inv.id}`);
    expect(doc.status).toBe('draft');
    expect(doc.sentAt).toBeTruthy();
    expect(hasGoneOut(doc)).toBe(true);
    // What the delete warning read before: a field the API doesn't have.
    expect(doc).not.toHaveProperty('sharedAt');
  });
});
