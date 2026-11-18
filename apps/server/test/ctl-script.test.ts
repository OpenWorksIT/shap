/**
 * shap-ctl.sh's steps for Shap Accountant (deploy/vps/ctl/shap-ctl.sh), run as the tests can: each
 * function sourced on its own, against a stand-in docker that answers from the test and writes down
 * every call. What's checked: only the server's own Shap's login is given CREATEDB, read from the
 * compose files and never trusted beyond a plain login name; a superuser is left as it is; a test
 * server added with --test-server may make databases, a real added company never.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '../../../deploy/vps/ctl/shap-ctl.sh');
const ADD = join(import.meta.dirname, '../../../deploy/vps/add-company.sh');

const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  "compose config --format json") printf '%s' "$FAKE_CONFIG" ;;
  *"select rolsuper or rolcreatedb"*) printf '%s\\n' "$FAKE_CAN" ;;
  *"select 1 from pg_roles"*) case "$*" in *"'shap_test'"*) echo 1 ;; esac ;;
  *"alter role"*) [ "\${FAKE_ALTER_FAILS:-}" = yes ] && exit 1 ;;
esac
exit 0
`;

/** Runs one of the script's steps; returns what it wrote to status.json and every docker call. */
function run(step: 'practice' | 'test_servers', env: { config?: unknown; can?: string; alterFails?: boolean; companies?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shap-ctl-script-'));
  const bin = join(dir, 'bin');
  const vps = join(dir, 'vps');
  const ctl = join(dir, 'ctl');
  for (const d of [bin, vps, ctl]) mkdirSync(d);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  if (env.companies) {
    mkdirSync(join(vps, 'companies'));
    for (const [slug, body] of Object.entries(env.companies)) writeFileSync(join(vps, 'companies', `${slug}.env`), body);
  }
  const log = join(dir, 'docker.log');
  writeFileSync(log, '');
  let code = 0;
  try {
    // $0 is the test's own name, so the script sees it's sourced and doesn't run main.
    execFileSync('bash', ['-c', `source "$1"; VPS="$2"; CTL="$3"; ${step}`, 'shap-ctl-test', SCRIPT, vps, ctl], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_LOG: log,
        FAKE_CONFIG: JSON.stringify(env.config ?? {}),
        FAKE_CAN: env.can ?? '',
        FAKE_ALTER_FAILS: env.alterFails ? 'yes' : '',
      },
      stdio: 'pipe',
    });
  } catch (err) {
    code = (err as { status?: number }).status ?? 1;
  }
  const status = existsSync(join(ctl, 'status.json')) ? (JSON.parse(readFileSync(join(ctl, 'status.json'), 'utf8')) as Record<string, any>) : {};
  return { code, status, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

const appUrl = (url: string) => ({ services: { app: { environment: { DATABASE_URL: url } }, 'app-friend': { environment: { DATABASE_URL: 'postgres://shap_friend:pw@db:5432/shap_friend' } } } });

describe('shap-ctl: Shap Accountant’s databases', () => {
  it('leaves the default install’s superuser as it is', () => {
    const r = run('practice', { config: appUrl('postgres://shap:made-up-password@db:5432/shap'), can: 't' });
    expect(r.code).toBe(0);
    expect(r.status.practice).toMatchObject({ ok: true, login: 'shap', message: expect.stringMatching(/may already make databases/) });
    expect(r.calls.some((c) => c.includes('alter role'))).toBe(false);
  });

  it('gives a least-privilege login CREATEDB, and nothing more', () => {
    const r = run('practice', { config: appUrl('postgres://shap_app:made-up@db:5432/shap'), can: 'f' });
    expect(r.code).toBe(0);
    expect(r.status.practice).toMatchObject({ ok: true, login: 'shap_app', message: expect.stringMatching(/may now make databases/) });
    const alters = r.calls.filter((c) => c.includes('alter role'));
    expect(alters).toHaveLength(1);
    expect(alters[0]).toMatch(/alter role "shap_app" createdb$/);
    // Only the server's own Shap's login: an added company's never comes into it.
    expect(r.calls.join('\n')).not.toMatch(/shap_friend/);
  });

  it('says so when Postgres refuses, or doesn’t know the login', () => {
    expect(run('practice', { config: appUrl('postgres://shap_app:x@db/shap'), can: 'f', alterFails: true })).toMatchObject({ code: 1, status: { practice: { ok: false, message: expect.stringMatching(/didn't let/) } } });
    expect(run('practice', { config: appUrl('postgres://shap_gone:x@db/shap'), can: '' })).toMatchObject({ code: 1, status: { practice: { ok: false, message: expect.stringMatching(/doesn't know/) } } });
  });

  it('never uses a login that isn’t a plain name, or one it couldn’t read', () => {
    for (const url of ["postgres://x';drop role shap;--:pw@db/shap", 'postgres://"shap" createdb superuser:pw@db/shap', 'postgres://SHAP:pw@db/shap']) {
      const r = run('practice', { config: appUrl(url), can: 'f' });
      expect(r.code).toBe(1);
      expect(r.status.practice).toMatchObject({ ok: false, login: '', message: expect.stringMatching(/Couldn't read/) });
      expect(r.calls.filter((c) => c.includes('psql'))).toEqual([]);
    }
    expect(run('practice', { config: {} })).toMatchObject({ code: 1, status: { practice: { ok: false, login: '' } } });
  });

  it('lets a test server added here make databases, and never a real company added here', () => {
    const r = run('test_servers', {
      companies: {
        test: 'SHAP_DOMAIN=shaptest.example.co.za\nTEST_SERVER=true\nCOLLECTOR_URL=off\n',
        friend: 'SHAP_DOMAIN=shap.friend.example.co.za\nMFA_REQUIRED=true\n',
        sneaky: 'SHAP_DOMAIN=x\n# TEST_SERVER=true\nTEST_SERVER=truely\n',
      },
    });
    expect(r.code).toBe(0);
    const alters = r.calls.filter((c) => c.includes('alter role'));
    expect(alters).toEqual([expect.stringMatching(/alter role shap_test createdb$/)]);
    // Without any added companies, nothing is done.
    expect(run('test_servers').calls).toEqual([]);
  });

  it('is asked for by the app’s request, and add-company.sh gives a test server the same', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toMatch(/^\s+practice\) practice ;;$/m);
    // The request file is read as a-z and - only, then must be one of the fixed actions.
    expect(script).toMatch(/tr -dc 'a-z-'/);
    const add = readFileSync(ADD, 'utf8');
    expect(add).toMatch(/if \[ "\$TEST_SERVER" = true \]; then\n\s+docker compose exec -T db psql -U shap -d postgres -v ON_ERROR_STOP=1 -qc "alter role \$DB createdb"/);
    expect(add).toMatch(/Shap Accountant isn't for a company added here: an accounting practice runs Shap on a server of its own/);
  });
});
