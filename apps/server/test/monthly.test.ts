/** Monthly invoices: made on their day, emailed or left as drafts, never twice. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mail } from '../src/lib/mailer.js';
import { dayIn, forMonth, monthlyAttention, runMonthly } from '../src/modules/monthly.js';
import { login, setup, type TestEnv } from './helpers.js';

describe('the month in an invoice’s wording', () => {
  it('moves to the invoice’s month, keeping the style', () => {
    expect(forMonth('Hosting – October 2026', '2026-11')).toBe('Hosting – November 2026');
    expect(forMonth('Support Oct 2026 and oct-2026', '2027-01')).toBe('Support Jan 2027 and jan-2027');
    expect(forMonth('Monthly maintenance', '2026-11')).toBe('Monthly maintenance');
    expect(dayIn('2027-02', 31)).toBe('2027-02-28');
    expect(dayIn('2026-11', 1)).toBe('2026-11-01');
  });
});

describe('monthly invoices', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let first: { id: string; number: string };
  let scheduleId: string;
  const sent: Mail[] = [];
  const mailer = { send: async (m: Mail) => void sent.push(m) };
  const series = () =>
    env.sql<{ id: string; number: string; issueDate: string; status: string; title: string; totalCents: number; sentAt: Date | null; period: string }[]>`
      select id, number, issue_date::text, status, title, total_cents, sent_at, monthly_period as period from documents
      where monthly_id = ${scheduleId} order by issue_date`;

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const client = await owner.post('/api/clients', { name: 'Clinic Co', email: 'accounts@clinic.example' });
    first = await owner.post('/api/documents', {
      kind: 'invoice',
      clientId: client.id,
      issueDate: '2026-10-01',
      title: 'Hosting – October 2026',
      lines: [{ category: 'other', description: 'Server hosting and support, October 2026', qty: 1, unitPriceCents: 200000 }],
    });
    await owner.post(`/api/documents/${first.id}/issue`);
  });
  afterAll(() => env.close());

  it('makes an invoice monthly, starting the month after', async () => {
    const bad = await owner.call({ method: 'POST', url: `/api/documents/${first.id}/monthly`, payload: { dayOfMonth: 1, startsOn: '2026-11-01', mode: 'send', emailTo: '' } });
    expect(bad.json().error).toMatch(/email address/);
    const s = await owner.post(`/api/documents/${first.id}/monthly`, { dayOfMonth: 1, startsOn: '2026-11-01', mode: 'send', emailTo: 'accounts@clinic.example' });
    scheduleId = s.id;
    expect(s).toMatchObject({ clientName: 'Clinic Co', nextDate: '2026-11-01', made: 1, mode: 'send' });
    expect((await owner.get(`/api/documents/${first.id}/monthly`)).schedule.id).toBe(scheduleId);
  });

  it('sends nothing before the day, then makes and emails it once', async () => {
    expect((await runMonthly(env.sql, mailer, { emailOn: true, on: '2026-10-31' })).created).toBe(0);
    expect(await runMonthly(env.sql, mailer, { emailOn: true, on: '2026-11-01' })).toEqual({ created: 1, emailed: 1, failed: 0 });
    // Again the same day (or a second server check): nothing more.
    expect((await runMonthly(env.sql, mailer, { emailOn: true, on: '2026-11-01' })).created).toBe(0);
    const [, nov] = await series();
    expect(nov).toMatchObject({ issueDate: '2026-11-01', status: 'issued', title: 'Hosting – November 2026', totalCents: 200000, period: '2026-11' });
    expect(nov!.number).not.toBe(first.number);
    expect(nov!.sentAt).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'accounts@clinic.example', subject: expect.stringContaining(nov!.number) });
    expect(sent[0]!.attachments![0]!.contentType).toBe('application/pdf');
    const [line] = await env.sql<{ description: string }[]>`select description from document_lines where document_id = ${nov!.id}`;
    expect(line!.description).toBe('Server hosting and support, November 2026');
  });

  it('carries a changed price on, and catches up after the server was off', async () => {
    const [, nov] = await series();
    await owner.post(`/api/documents/${nov!.id}`, { issueDate: '2026-11-01', title: nov!.title, lines: [{ category: 'other', description: 'Server hosting and support, November 2026', qty: 1, unitPriceCents: 250000 }] }, 'PUT');
    // Off through December: on 15 January both December's and January's go out.
    expect(await runMonthly(env.sql, mailer, { emailOn: true, on: '2027-01-15' })).toEqual({ created: 2, emailed: 2, failed: 0 });
    const all = await series();
    expect(all.map((d) => [d.period, d.totalCents])).toEqual([
      ['2026-10', 200000],
      ['2026-11', 250000],
      ['2026-12', 250000],
      ['2027-01', 250000],
    ]);
  });

  it('leaves it as a draft to check, when that’s the choice', async () => {
    await owner.post(`/api/monthly-invoices/${scheduleId}`, { dayOfMonth: 31, startsOn: '2026-11-01', mode: 'draft', emailTo: '' }, 'PUT');
    expect(await runMonthly(env.sql, mailer, { emailOn: true, on: '2027-02-28' })).toEqual({ created: 1, emailed: 0, failed: 0 });
    const feb = (await series()).at(-1)!;
    expect(feb).toMatchObject({ issueDate: '2027-02-28', status: 'draft', period: '2027-02' });
    const att = await monthlyAttention(env.sql);
    expect(att.waiting.map((w) => w.id)).toContain(feb.id);
    // The invoice it started from isn't nagged about, though it was never emailed from Shap.
    expect(att.waiting.map((w) => w.id)).not.toContain(first.id);
    expect((await owner.get('/api/dashboard')).monthlyInvoices.waiting.length).toBeGreaterThan(0);
  });

  it('says so on Home when it couldn’t email, and tries again', async () => {
    await owner.post(`/api/monthly-invoices/${scheduleId}`, { dayOfMonth: 1, startsOn: '2026-11-01', mode: 'send', emailTo: 'accounts@clinic.example' }, 'PUT');
    expect(await runMonthly(env.sql, mailer, { emailOn: false, on: '2027-03-01' })).toMatchObject({ created: 1, failed: 1 });
    const mar = (await series()).at(-1)!;
    const att = await monthlyAttention(env.sql);
    expect(att.failed[0]).toMatchObject({ id: scheduleId, documentId: mar.id, error: expect.stringMatching(/Email isn’t set up/) });
    // Made, but not sent: it's waiting to be emailed by hand.
    expect(mar).toMatchObject({ period: '2027-03', status: 'issued', sentAt: null });
    expect(att.waiting.map((w) => w.id)).toContain(mar.id);
    // Through the app, where email isn't set up in tests either: nothing new is made twice.
    const r = await owner.post(`/api/monthly-invoices/${scheduleId}/run`, {});
    expect(r).toEqual({ created: 0, emailed: 0, failed: 1 });
    // Once email works, Run now sends the one that missed out, and only that one.
    const before = sent.length;
    expect(await runMonthly(env.sql, mailer, { emailOn: true, on: '2027-03-01', only: scheduleId, resend: true })).toEqual({ created: 0, emailed: 1, failed: 0 });
    expect(sent.at(-1)!.subject).toContain(mar.number);
    expect(sent.length).toBe(before + 1);
    expect((await series()).at(-1)!.sentAt).toBeTruthy();
  });

  it('waits while the books are closed for that date', async () => {
    await env.sql`update settings set lock_date = '2027-04-30'`;
    expect(await runMonthly(env.sql, mailer, { emailOn: true, on: '2027-04-02' })).toEqual({ created: 0, emailed: 0, failed: 1 });
    expect((await monthlyAttention(env.sql)).failed[0]!.error).toMatch(/books are closed/);
    await env.sql`update settings set lock_date = null`;
    expect((await runMonthly(env.sql, mailer, { emailOn: true, on: '2027-04-02' })).created).toBe(1);
    expect((await monthlyAttention(env.sql)).failed).toHaveLength(0);
  });

  it('stops at its end date, or when stopped', async () => {
    await owner.post(`/api/monthly-invoices/${scheduleId}`, { dayOfMonth: 1, startsOn: '2026-11-01', endsOn: '2027-05-31', mode: 'send', emailTo: 'accounts@clinic.example' }, 'PUT');
    expect((await runMonthly(env.sql, mailer, { emailOn: true, on: '2027-06-15' })).created).toBe(1);
    expect((await runMonthly(env.sql, mailer, { emailOn: true, on: '2027-07-15' })).created).toBe(0);
    await owner.post(`/api/monthly-invoices/${scheduleId}`, { dayOfMonth: 1, startsOn: '2026-11-01', mode: 'send', emailTo: 'accounts@clinic.example', active: false }, 'PUT');
    expect((await runMonthly(env.sql, mailer, { emailOn: true, on: '2027-08-15' })).created).toBe(0);
    const list = await owner.get('/api/monthly-invoices');
    expect(list[0]).toMatchObject({ active: false, nextDate: null });
  });
});

describe('mail problems, in words', () => {
  it('says what to fix without repeating the password', async () => {
    const { mailProblem } = await import('../src/lib/mailer.js');
    expect(mailProblem({ code: 'EAUTH', responseCode: 535, message: '535 auth failed for user x:secret' })).toMatch(/username or password/);
    expect(mailProblem({ code: 'ETIMEDOUT' })).toMatch(/465 with smtps/);
    expect(mailProblem({ code: 'EDNS' })).toMatch(/wasn’t found/);
    expect(mailProblem(new Error('x'))).toBe('the email couldn’t be sent');
  });
});
