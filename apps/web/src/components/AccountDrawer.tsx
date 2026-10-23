import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { AuthenticatorSetup, CodeInput, RecoveryCodes } from './TwoFactor';
import { Drawer, Field, useToast } from './ui';

interface MfaStatus {
  enabled: boolean;
  required: boolean;
  recoveryCodesLeft: number;
}

import { passwordProblem, ROLE_LABELS } from '@shap/shared';

/** Your own account: two-factor sign-in, recovery codes, sign out. */
export function AccountDrawer({ onClose }: { onClose: () => void }) {
  const { user, logout } = useAuthed();
  const toast = useToast();
  const status = useApi<MfaStatus>('/api/auth/mfa');
  const [mode, setMode] = useState<'view' | 'setup' | 'codes' | 'regen' | 'disable'>('view');
  const [setup, setSetup] = useState<{ challenge: string; secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const s = status.data;
  return (
    <Drawer title={user.name} sub={`${ROLE_LABELS[user.role]} · ${user.email}`} onClose={onClose} footer={<button className="btn" onClick={() => void logout()}>Sign out</button>}>
      <div className="stack-lg">
        <section className="stack">
          <h3>Two-factor sign-in</h3>
          {!s ? (
            <p className="small muted">Loading…</p>
          ) : mode === 'view' ? (
            <>
              <p className="small">
                {s.enabled
                  ? `On. You sign in with your password and a code from your authenticator app. ${s.recoveryCodesLeft} recovery code${s.recoveryCodesLeft === 1 ? '' : 's'} left.`
                  : 'Off. Turn it on so a stolen password alone can’t open your books.'}
              </p>
              <div className="row wrap">
                {!s.enabled && (
                  <button
                    className="btn primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setSetup(await api('/api/auth/mfa/setup', { body: {} }));
                        setMode('setup');
                      })
                    }
                  >
                    Turn on
                  </button>
                )}
                {s.enabled && (
                  <button className="btn" onClick={() => (setMode('regen'), setCode(''))}>
                    New recovery codes
                  </button>
                )}
                {s.enabled && !s.required && (
                  <button className="btn danger" onClick={() => (setMode('disable'), setPassword(''))}>
                    Turn off
                  </button>
                )}
              </div>
              {error && <div className="banner alert small">{error}</div>}
            </>
          ) : mode === 'setup' && setup ? (
            <AuthenticatorSetup
              otpauthUrl={setup.otpauthUrl}
              secret={setup.secret}
              busy={busy}
              error={error}
              onSubmit={(c) =>
                void run(async () => {
                  const r = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/enrol', { body: { challenge: setup.challenge, code: c } });
                  setCodes(r.recoveryCodes);
                  setMode('codes');
                })
              }
            />
          ) : mode === 'codes' ? (
            <RecoveryCodes
              codes={codes}
              doneLabel="Done"
              onDone={() => {
                setMode('view');
                void status.reload();
                toast('Two-factor sign-in is on');
              }}
            />
          ) : mode === 'regen' ? (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const r = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes', { body: { code: code.replace(/\s/g, '') } });
                  setCodes(r.recoveryCodes);
                  setMode('codes');
                });
              }}
            >
              <label htmlFor="regen-code" className="small">
                Enter a code from your authenticator app. Your old recovery codes will stop working.
              </label>
              <CodeInput id="regen-code" value={code} onChange={setCode} />
              {error && <div className="banner alert small">{error}</div>}
              <div className="row">
                <button className="btn primary" disabled={busy}>
                  Make new codes
                </button>
                <button type="button" className="btn quiet" onClick={() => setMode('view')}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api('/api/auth/mfa/disable', { body: { password } });
                  setMode('view');
                  void status.reload();
                  toast('Two-factor sign-in is off');
                });
              }}
            >
              <label htmlFor="disable-pw" className="small">
                Enter your password to turn off two-factor sign-in.
              </label>
              <input id="disable-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
              {error && <div className="banner alert small">{error}</div>}
              <div className="row">
                <button className="btn danger" disabled={busy || !password}>
                  Turn off
                </button>
                <button type="button" className="btn quiet" onClick={() => setMode('view')}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
        <ChangePassword />
      </div>
    </Drawer>
  );
}

/** Your own password: the current one first. Signs you out everywhere else. */
function ChangePassword() {
  const { user } = useAuthed();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const problem = f.next ? passwordProblem(f.next, user) : null;
  if (!open)
    return (
      <section className="stack">
        <h3>Your password</h3>
        <div className="row">
          <button className="btn" onClick={() => setOpen(true)}>
            Change my password
          </button>
        </div>
      </section>
    );
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (f.next !== f.again) return setError('The new passwords don’t match');
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/password', { body: { currentPassword: f.current, newPassword: f.next } });
      toast('Password changed. You’re signed out on your other devices.');
      setOpen(false);
      setF({ current: '', next: '', again: '' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t change it');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="stack">
      <h3>Your password</h3>
      <form className="stack" onSubmit={save}>
        <Field label="Current password">
          {(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoFocus />}
        </Field>
        <Field label="New password" hint={problem ?? 'At least 10 characters. A few unrelated words together is strong and easy to remember.'} error={problem ?? undefined}>
          {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />}
        </Field>
        <Field label="New password again">
          {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} />}
        </Field>
        {error && <div className="banner alert small">{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || !f.current || !f.next || Boolean(problem)}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
          <button type="button" className="btn quiet" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
