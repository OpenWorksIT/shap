import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { useToast } from './ui';

/** Six-digit code input tuned for phones: numeric keypad and one-time-code autofill. */
export function CodeInput({ value, onChange, id, autoFocus = true }: { value: string; onChange: (v: string) => void; id: string; autoFocus?: boolean }) {
  return (
    <input
      id={id}
      className="input code-input"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]*"
      maxLength={7}
      placeholder="123 456"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^\d ]/g, ''))}
      autoFocus={autoFocus}
    />
  );
}

/** Scan-or-type setup for an authenticator app, then confirm with the first code. */
export function AuthenticatorSetup({
  otpauthUrl,
  secret,
  busy,
  error,
  onSubmit,
}: {
  otpauthUrl: string;
  secret: string;
  busy: boolean;
  error: string;
  onSubmit: (code: string) => void;
}) {
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => {
    void QRCode.toDataURL(otpauthUrl, { margin: 1, width: 200, color: { dark: '#1f2b33', light: '#ffffff' } }).then(setQr);
  }, [otpauthUrl]);
  const grouped = secret.replace(/(.{4})/g, '$1 ').trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(code.replace(/\s/g, ''));
  };
  return (
    <form className="stack" onSubmit={submit}>
      <ol className="setup-steps">
        <li>
          Install an authenticator app if you don’t have one: <strong>Aegis</strong> or <strong>FreeOTP</strong> (Android), the built-in{' '}
          <strong>Passwords</strong> app (iPhone), or Google or Microsoft Authenticator.
        </li>
        <li>
          Scan this code with the app.
          <div className="qr" style={{ marginTop: 10 }}>
            {qr && <img src={qr} alt="QR code to add Shap to your authenticator app" width={200} height={200} />}
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            On this phone? <a href={otpauthUrl}>Open in your authenticator app</a>, or type this key: <span className="key">{grouped}</span>
          </div>
        </li>
        <li>
          <label htmlFor="enrol-code">Enter the 6-digit code the app shows</label>
          <CodeInput id="enrol-code" value={code} onChange={setCode} autoFocus={false} />
        </li>
      </ol>
      {error && (
        <div className="banner alert small" role="alert">
          {error}
        </div>
      )}
      <button className="btn primary big block" disabled={busy || code.replace(/\s/g, '').length !== 6}>
        {busy ? 'Checking…' : 'Turn on two-factor sign-in'}
      </button>
    </form>
  );
}

/** Shown once: single-use codes for when the phone is lost. */
export function RecoveryCodes({ codes, onDone, doneLabel = 'Continue' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const text = `Shap recovery codes\nEach code works once, if you can't use your authenticator app.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shap-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="stack">
      <p className="small">
        If you lose your phone, each of these codes lets you sign in once. Keep them somewhere safe, away from your phone. They won’t be shown
        again.
      </p>
      <ul className="recovery-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="row wrap">
        <button type="button" className="btn small" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast('Recovery codes copied'))}>
          Copy
        </button>
        <button type="button" className="btn small" onClick={download}>
          Download
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I’ve saved these codes
      </label>
      <button className="btn primary big block" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </button>
    </div>
  );
}
