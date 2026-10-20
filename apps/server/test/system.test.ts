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
  env = await setup({ env: { CTL_DIR: ctl, BACKUP_DIR: backups, GIT_SHA: 'abc1234' } });
  owner = await login(env.app, 'owner@example.co.za');
});
afterAll(() => env.close());

describe('Settings → Updates & backups', () => {
  it('shows the version, and says so when the server side isn’t set up', async () => {
    const s = await owner.get('/api/system');
    expect(s).toMatchObject({ version: '1.1.5', gitSha: 'abc1234', managed: false, backups: [] });
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

  it('lists backups and downloads them, and nothing else', async () => {
    writeFileSync(join(backups, 'shap-daily-2026-10-19_0230.dump'), 'PGDMP fake');
    writeFileSync(join(backups, 'notes.txt'), 'not a backup');
    const s = await owner.get('/api/system');
    expect(s.backups.map((b: { name: string }) => b.name)).toEqual(['shap-daily-2026-10-19_0230.dump']);
    const dl = await owner.call({ method: 'GET', url: '/api/system/backups/shap-daily-2026-10-19_0230.dump' });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('PGDMP fake');
    expect((await owner.call({ method: 'GET', url: '/api/system/backups/notes.txt' })).statusCode).toBe(404);
    expect((await owner.call({ method: 'GET', url: '/api/system/backups/..%2F..%2Fetc%2Fpasswd' })).statusCode).toBe(404);
  });

  it('is for the owner only', async () => {
    const acct = await login(env.app, 'accountant@example.co.za');
    expect((await acct.call({ method: 'GET', url: '/api/system' })).statusCode).toBe(403);
    const site = await login(env.app, 'site@example.co.za');
    expect((await site.call({ method: 'POST', url: '/api/system/request', payload: { action: 'backup' } })).statusCode).toBe(403);
  });
});
