import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let owner: Awaited<ReturnType<typeof login>>;
const ctl = mkdtempSync(join(tmpdir(), 'shap-ctl-'));
const backups = mkdtempSync(join(tmpdir(), 'shap-backups-'));

beforeAll(async () => {
  env = await setup({ env: { CTL_DIR: ctl, REQUEST_DIR: ctl, BACKUP_DIR: backups, GIT_SHA: 'abc1234' } });
  owner = await login(env.app, 'owner@example.co.za');
});
afterAll(() => env.close());

describe('Settings → Updates & backups', () => {
  it('shows the version, and says so when the server side isn’t set up', async () => {
    const s = await owner.get('/api/system');
    expect(s).toMatchObject({ version: '1.24.0', gitSha: 'abc1234', managed: false, backups: [] });
    const r = await owner.call({ method: 'POST', url: '/api/system/request', payload: { action: 'update' } });
    expect(r.statusCode).toBe(400);
  });

  it('passes requests to the server and shows what it reports', async () => {
    writeFileSync(join(ctl, 'status.json'), JSON.stringify({ check: { at: '2026-10-19T08:00:00Z', behind: 2, changes: [{ sha: 'def5678', subject: 'Bank statements' }] } }));
    await owner.post('/api/system/request', { action: 'update' });
    expect(readFileSync(join(ctl, 'request'), 'utf8').trim()).toBe('update');
    const s = await owner.get('/api/system');
    expect(s).toMatchObject({ managed: true, pending: 'update', status: { check: { behind: 2 } } });
    const bad = await owner.call({ method: 'POST', url: '/api/system/request', payload: { action: 'rm -rf' } });
    expect(bad.statusCode).toBe(400);
  });

  it('lists and downloads only this company’s backups — not other companies’ dumps', async () => {
    // current_database() in tests is shap_test, so this company's dumps are "shap_test-…".
    const mine = 'shap_test-daily-2026-10-19_0230.dump';
    writeFileSync(join(backups, mine), 'PGDMP fake');
    writeFileSync(join(backups, 'notes.txt'), 'not a backup');
    // shap-ctl dumps every database on the box into one shared folder, so another company's dump
    // sits here too; it must never be listed or fetched through this company's app.
    writeFileSync(join(backups, 'shap_other-daily-2026-10-19_0230.dump'), 'PGDMP other company');
    const s = await owner.get('/api/system');
    expect(s.backups.map((b: { name: string }) => b.name)).toEqual([mine]);
    // A backup is everything: it takes your password, for a link that's only good for you, briefly.
    expect((await owner.call({ method: 'GET', url: `/api/system/backups/${mine}` })).statusCode).toBe(400);
    expect((await owner.call({ method: 'POST', url: `/api/system/backups/${mine}/link`, payload: { password: 'nope-nope-1' } })).statusCode).toBe(400);
    const { url } = await owner.post(`/api/system/backups/${mine}/link`, { password: 'test-password-1' });
    expect((await owner.call({ method: 'GET', url: url.replace('shap_test-daily', 'shap_test-manual') })).statusCode).toBe(400);
    const dl = await owner.call({ method: 'GET', url });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('PGDMP fake');
    expect((await owner.call({ method: 'GET', url: '/api/system/backups/notes.txt' })).statusCode).toBe(404);
    expect((await owner.call({ method: 'GET', url: '/api/system/backups/..%2F..%2Fetc%2Fpasswd' })).statusCode).toBe(404);
    // The other company's dump: not listed above, and no download link can be minted for it.
    expect((await owner.call({ method: 'POST', url: '/api/system/backups/shap_other-daily-2026-10-19_0230.dump/link', payload: { password: 'test-password-1' } })).statusCode).toBe(404);
  });

  it('is for the owner only', async () => {
    const acct = await login(env.app, 'accountant@example.co.za');
    expect((await acct.call({ method: 'GET', url: '/api/system' })).statusCode).toBe(403);
    const site = await login(env.app, 'site@example.co.za');
    expect((await site.call({ method: 'POST', url: '/api/system/request', payload: { action: 'backup' } })).statusCode).toBe(403);
  });
});
