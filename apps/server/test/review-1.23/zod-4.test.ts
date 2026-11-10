/**
 * From the independent review of 1.23.1, the move to zod 4 (each failed before its fix): a refused
 * request said what zod 4 says when a schema has no words of its own ("Invalid input: expected
 * string, received undefined", or the pattern a field must match) rather than "Required" and
 * "Invalid" as before. And two older ones found on the way: an unknown accountant export, and a
 * feedback trail time no date can hold (on the open collector too), answered 500, not 400.
 * All data made up.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import '@shap/shared';
import { login, ref, setup, type TestEnv } from '../helpers.js';

describe('the words a refused request comes back with', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup({ env: { FEEDBACK_DIR: mkdtempSync(join(tmpdir(), 'shap-fb-')), COLLECT: 'true' } });
    owner = await login(env.app, 'owner@example.co.za');
  });
  afterAll(() => env.close());

  it('says a field left out is required, plainly', async () => {
    const r = await owner.call({ method: 'POST', url: '/api/clients', payload: { email: 'made.up@example.co.za' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('Required');
  });

  it('doesn’t show the pattern a field must match', async () => {
    const bank = await (await ref(env.sql)).src('Business bank');
    const r = await owner.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'emp201', period: '', date: '2026-06-05', amountCents: 1_000, sourceId: bank } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('Choose the month');
    // A pattern with no words of its own says "Invalid", not the pattern.
    expect(z.string().regex(/^\d{4}-\d{2}$/).safeParse('').error?.issues[0]?.message).toBe('Invalid');
  });

  it('refuses an unknown accountant export with a 400, not a server error', async () => {
    expect((await owner.call({ method: 'GET', url: '/api/accountant-export?dataset=made-up' })).statusCode).toBe(400);
  });

  it('refuses a feedback trail time no date can hold, here and on the collector', async () => {
    const report = { kind: 'bug', message: 'The total looks wrong (made up)', page: '/documents/x', title: 'Shap', at: new Date().toISOString(), trail: [{ t: 1e300, kind: 'click', detail: 'Save' }] };
    expect((await owner.call({ method: 'POST', url: '/api/feedback', payload: report })).statusCode).toBe(400);
    const r = await env.app.inject({ method: 'POST', url: '/collect/feedback', payload: { ...report, app: 'pocket', version: '1.0.0', platform: 'ios' } });
    expect(r.statusCode).toBe(400);
  });
});
