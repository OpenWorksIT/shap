/**
 * The audits, on Settings → Updates & backups: the books audit (run here, now) and the server's
 * security and privacy check (run on the server every 6 hours). Each finding is OK, worth a look,
 * or to fix. docs/AUDIT.md says what each covers.
 */
import { useEffect, useState } from 'react';
import { formatDate } from '@shap/shared';
import { api } from '../lib/api';
import { Icon } from './ui';

interface Item {
  level: 'ok' | 'warn' | 'fail';
  section: string;
  text: string;
}
interface Result {
  at: string;
  fails: number;
  warns: number;
  oks: number;
  items: Item[];
}

function Findings({ result }: { result: Result }) {
  const [all, setAll] = useState(false);
  const shown = all ? result.items : result.items.filter((i) => i.level !== 'ok');
  let section = '';
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="small" style={{ margin: 0 }}>
        {result.fails ? <strong className="audit-fails">{result.fails} to fix</strong> : <strong className="audit-clear">Nothing to fix</strong>}
        {result.warns ? `, ${result.warns} to look at` : ''} · {result.oks} checks fine · {formatDate(result.at.slice(0, 10))} {new Date(result.at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}
      </p>
      <ul className="audit-list">
        {shown.map((i, k) => {
          const head = i.section !== section ? (section = i.section) : null;
          return (
            <li key={k} className={`audit-${i.level}`}>
              {head && <span className="xs muted audit-section">{head}</span>}
              <span>
                <span className="audit-mark" aria-label={i.level === 'ok' ? 'Fine' : i.level === 'warn' ? 'Worth a look' : 'To fix'}>
                  {i.level === 'ok' ? '✓' : i.level === 'warn' ? '!' : '✕'}
                </span>{' '}
                {i.text}
              </span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn quiet small" style={{ alignSelf: 'start' }} onClick={() => setAll((x) => !x)}>
        {all ? 'Only what needs a look' : `Show all ${result.items.length} checks`}
      </button>
    </div>
  );
}

export function AuditChecks() {
  const [books, setBooks] = useState<Result | null>(null);
  const [server, setServer] = useState<(Result & { available: true }) | { available: false } | null>(null);
  const [busy, setBusy] = useState(false);
  const runBooks = async () => {
    setBusy(true);
    try {
      setBooks(await api<Result>('/api/audit/books'));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void runBooks();
    void api<(Result & { available: true }) | { available: false }>('/api/audit/server').then(setServer, () => setServer({ available: false }));
  }, []);
  return (
    <section className="panel panel-pad stack">
      <h3>Checks</h3>
      <p className="small muted" style={{ margin: 0 }}>
        What an accountant and a security reviewer would check, run on your own books and server. Every update of Shap passes the same kind of checks before it’s offered to you.
      </p>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row wrap" style={{ justifyContent: 'space-between' }}>
          <strong>Your books</strong>
          <button type="button" className="btn small" onClick={() => void runBooks()} disabled={busy}>
            <Icon name="check" size={14} />
            {busy ? 'Checking…' : 'Check again'}
          </button>
        </div>
        {books ? <Findings result={books} /> : <p className="small muted">Checking…</p>}
      </div>
      {server?.available && (
        <div className="stack" style={{ gap: 8 }}>
          <strong>The server</strong>
          <span className="xs muted">Security and privacy, checked on the server every 6 hours.</span>
          <Findings result={server} />
        </div>
      )}
    </section>
  );
}
