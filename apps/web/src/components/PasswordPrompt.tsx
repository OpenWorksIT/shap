import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Drawer, Field } from './ui';

/**
 * Asks for your password before something that hands over or replaces everything (a backup,
 * the company file). `ask` resolves with the password, or null if you cancel.
 */
export function usePasswordPrompt(): [ReactNode, (title: string, detail?: string) => Promise<string | null>] {
  const [open, setOpen] = useState<{ title: string; detail?: string } | null>(null);
  const [password, setPassword] = useState('');
  const done = useRef<((v: string | null) => void) | null>(null);
  const finish = (v: string | null) => {
    done.current?.(v);
    done.current = null;
    setOpen(null);
    setPassword('');
  };
  const ask = (title: string, detail?: string) =>
    new Promise<string | null>((resolve) => {
      done.current = resolve;
      setOpen({ title, detail });
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password) finish(password);
  };
  const node = open && (
    <Drawer title={open.title} onClose={() => finish(null)}>
      <form className="stack" onSubmit={submit}>
        <p className="small">{open.detail ?? 'Enter your password to confirm it’s you.'}</p>
        <Field label="Your password">
          {(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
        </Field>
        <div className="row">
          <button className="btn primary" disabled={!password}>
            Continue
          </button>
          <button type="button" className="btn quiet" onClick={() => finish(null)}>
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
  return [node, ask];
}
