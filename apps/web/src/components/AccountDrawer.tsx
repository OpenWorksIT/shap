import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { AuthenticatorSetup, CodeInput, RecoveryCodes } from './TwoFactor';
import { Drawer, useToast } from './ui';

interface MfaStatus {
  enabled: boolean;
  required: boolean;
  recoveryCodesLeft: number;
}

import { ROLE_LABELS } from '@shap/shared';

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
      </div>
    </Drawer>
  );
}
