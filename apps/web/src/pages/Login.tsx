import { useState, type FormEvent } from 'react';
import { Logo } from '../components/Logo';
import { AuthenticatorSetup, CodeInput, RecoveryCodes } from '../components/TwoFactor';
import { ApiError } from '../lib/api';
import { useSession, type LoginStep } from '../lib/session';

type Stage =
  | { kind: 'password' }
  | Exclude<LoginStep, { kind: 'done' }>
  | { kind: 'codes'; codes: string[]; enter: () => Promise<void> };

/** Sign-in: password, then the authenticator code (or first-time authenticator setup). */
export function LoginPage() {
  const { login, verifyMfa, enrolMfa } = useSession();
  const [stage, setStage] = useState<Stage>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const step = await login(email, password);
      if (step.kind !== 'done') {
        setPassword('');
        setStage(step);
      }
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (stage.kind !== 'verify') return;
    void run(async () => {
      try {
        await verifyMfa(stage.challenge, code.replace(/\s/g, ''));
      } catch (err) {
        // An expired challenge means starting again from the password.
        if (err instanceof ApiError && /start again/i.test(err.message)) setStage({ kind: 'password' });
        throw err;
      }
    });
  };

  const restart = () => {
    setStage({ kind: 'password' });
    setCode('');
    setError('');
  };

  return (
    <div className="login">
      <div className="login-card panel panel-pad stack">
        <Logo size={44} tagline />

        {stage.kind === 'password' && (
          <form className="stack" onSubmit={submitPassword}>
            <div style={{ marginTop: 12 }}>
              <h1>Sign in</h1>
              <p className="muted">Jobs, labour, quotes, invoices and the books.</p>
            </div>
            {error && (
              <div className="banner alert" role="alert">
                {error}
              </div>
            )}
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <button className="btn primary big block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        {stage.kind === 'verify' && (
          <form className="stack" onSubmit={submitCode}>
            <div style={{ marginTop: 12 }}>
              <h1>Enter your code</h1>
              <p className="muted">{useRecovery ? 'Type one of your recovery codes.' : 'Open your authenticator app and enter the 6-digit code for Shap.'}</p>
            </div>
            {error && (
              <div className="banner alert" role="alert">
                {error}
              </div>
            )}
            {useRecovery ? (
              <input className="input code-input" autoComplete="off" autoCapitalize="characters" placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} autoFocus aria-label="Recovery code" />
            ) : (
              <CodeInput id="code" value={code} onChange={setCode} />
            )}
            <button className="btn primary big block" disabled={busy || code.replace(/[\s-]/g, '').length < (useRecovery ? 8 : 6)}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <div className="row wrap login-links">
              <button type="button" className="btn quiet small" onClick={() => (setUseRecovery(!useRecovery), setCode(''), setError(''))}>
                {useRecovery ? 'Use my authenticator app' : 'Lost your phone? Use a recovery code'}
              </button>
              <button type="button" className="btn quiet small" onClick={restart}>
                Start again
              </button>
            </div>
          </form>
        )}

        {stage.kind === 'enrol' && (
          <div className="stack">
            <div style={{ marginTop: 12 }}>
              <h1>Set up two-factor sign-in</h1>
              <p className="muted">This server asks for a code from your phone as well as your password. It takes a minute, once.</p>
            </div>
            <AuthenticatorSetup
              otpauthUrl={stage.otpauthUrl}
              secret={stage.secret}
              busy={busy}
              error={error}
              onSubmit={(c) =>
                void run(async () => {
                  const r = await enrolMfa(stage.challenge, c);
                  setStage({ kind: 'codes', codes: r.recoveryCodes, enter: r.enter });
                })
              }
            />
            <button type="button" className="btn quiet small" onClick={restart}>
              Start again
            </button>
          </div>
        )}

        {stage.kind === 'codes' && (
          <div className="stack">
            <div style={{ marginTop: 12 }}>
              <h1>Save your recovery codes</h1>
            </div>
            <RecoveryCodes codes={stage.codes} onDone={() => void run(stage.enter)} doneLabel="Open Shap" />
          </div>
        )}
      </div>
    </div>
  );
}
