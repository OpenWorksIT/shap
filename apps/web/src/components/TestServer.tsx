/**
 * The test server (docs/TEST_SERVER.md): a banner on every screen saying the books are made up,
 * and, on Home for the owner, filling new books with made-up data for the setup chosen and wiping
 * them to set up again as another kind of business.
 */
import { useEffect, useState } from 'react';
import { entity, formatDate, INDUSTRIES } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useAuthed } from '../lib/session';

interface Fill {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  done: number;
  total: number;
  day: string | null;
  error: string | null;
  summary: { from: string; to: string; invoices: number; quotes: number; sales: number; costs: number; payRuns: number } | null;
}
interface Status {
  on: boolean;
  setupDone?: boolean;
  empty?: boolean;
  fill?: Fill;
}

let cached: Promise<Status> | null = null;
/** Is this a test server? Asked once a page load; `poll` keeps asking while the books fill. */
export function useTestServer(poll = false): [Status | null, () => void] {
  const [s, setS] = useState<Status | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const ask = tick === 0 ? (cached ??= api<Status>('/api/test-server').catch(() => ({ on: false }))) : api<Status>('/api/test-server').catch(() => ({ on: false }));
    void ask.then((x) => live && setS(x));
    return () => {
      live = false;
    };
  }, [tick]);
  useEffect(() => {
    if (!poll || !s?.fill?.running) return;
    const t = setTimeout(() => setTick((n) => n + 1), 1500);
    return () => clearTimeout(t);
  }, [poll, s, tick]);
  return [s, () => setTick((n) => n + 1)];
}

/** Across the top of every screen on a test server. */
export function TestServerBanner() {
  const [s] = useTestServer();
  if (!s?.on) return null;
  return (
    <div className="test-banner" role="status">
      <strong>Test server.</strong> Made-up books for trying Shap out: nothing here is a real business, and nothing is shared from it.
    </div>
  );
}

/** Home, for the owner: fill the books with made-up data for this setup, or wipe them and start again. */
export function TestServerPanel() {
  const { settings, isOwner } = useAuthed();
  const [s, refresh] = useTestServer(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [typed, setTyped] = useState('');
  const fill = s?.fill;
  // Filled: show the books (the screen was loaded while they were empty).
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (fill?.running) setWasRunning(true);
    else if (wasRunning && fill?.finishedAt && !fill.error) window.location.assign('/');
  }, [fill?.running, fill?.finishedAt, fill?.error, wasRunning]);
  if (!s?.on || !isOwner) return null;

  const industry = INDUSTRIES.find((i) => i.key === settings.industry)?.label ?? 'Something else';
  const setup = [entity(settings.businessType).label, industry, settings.vatRegistered ? `VAT (category ${settings.vatCategory})` : 'not registered for VAT'].join(' · ');
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/test-server/populate', { body: {} });
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t start filling the books');
    } finally {
      setBusy(false);
    }
  };
  const wipe = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/test-server/wipe', { body: { confirm: typed } });
      cached = null;
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t wipe the books');
      setBusy(false);
    }
  };

  return (
    <section className="panel panel-pad stack-sm test-panel">
      <h3>Test server</h3>
      <p className="small muted">Set up as: {setup}.</p>
      {fill?.running ? (
        <>
          <p className="small">
            Filling the books with made-up data{fill.day ? `: up to ${formatDate(fill.day)}` : ''}. This takes a minute or two; leave this page open or come back to it.
          </p>
          <progress max={fill.total || 1} value={fill.done} style={{ width: '100%' }} />
        </>
      ) : s.empty ? (
        <>
          <p className="small">
            Fill these books with made-up data for this setup: the last full financial year and this one to date. Quotes, invoices and payments, costs with their slips, and whatever this setup uses (payroll, casual workers, sales and stock, bills, the logbook, VAT, provisional tax, dividends or drawings). The same setup always gets the same figures.
          </p>
          <div>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void start()}>
              Fill with made-up data
            </button>
          </div>
        </>
      ) : (
        <p className="small">
          {fill?.summary
            ? `Filled from ${formatDate(fill.summary.from)} to ${formatDate(fill.summary.to)}: ${fill.summary.invoices} invoices, ${fill.summary.quotes} quotes, ${fill.summary.sales} sales, ${fill.summary.costs} costs and ${fill.summary.payRuns} pay runs.`
            : 'These books have data in them.'}{' '}
          To try another kind of business, wipe them and answer the setup questions again.
        </p>
      )}
      {fill?.error && <div className="banner alert small">The filling stopped: {fill.error}. Wipe the books and try again, or tell OpenWorks (Feedback).</div>}
      {error && <div className="banner alert small">{error}</div>}
      {!fill?.running && !s.empty && (
        wiping ? (
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              void wipe();
            }}
          >
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type WIPE" aria-label="Type WIPE to wipe the test books" autoFocus />
            <button className="btn danger" disabled={busy || typed.trim().toUpperCase() !== 'WIPE'}>
              Wipe the books
            </button>
            <button type="button" className="btn quiet" onClick={() => setWiping(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div>
            <button type="button" className="btn" onClick={() => setWiping(true)}>
              Wipe and start again
            </button>
          </div>
        )
      )}
    </section>
  );
}
