/**
 * Locks (Shap's docs/LOCKS.md): what's closed, and month end for a business that sells. Everything
 * dated on or before the lock date is closed; the owner locks a month or a year, and reopens the
 * books with the reason to put something right, then locks them again. Month end is closed by hand, or each month locks itself
 * on a day of the next.
 */
import { useState, type FormEvent } from 'react';
import { formatDate, monthLabel } from '@shap/shared';
import { Empty, ErrorBox, Field, Loading, Money, Segmented, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';

interface Period {
  start: string;
  end: string;
  ended: boolean;
  locked: boolean;
  salesCount: number;
  salesCents: number;
  refundsCents: number;
  invoicedCents: number;
  costsCents: number;
  bankOpen: number;
}
export interface LockState {
  lockDate: string | null;
  reopened: { relockDate: string; at: string | null; byName: string | null; reason: string } | null;
  sells: boolean;
  monthEnd: { mode: 'manual' | 'auto'; day: number; next: { on: string; through: string } | null };
  monthDue: string | null;
  periods: Period[];
  /** A VAT vendor's VAT periods that have ended and are closed. */
  vatPeriods: { start: string; end: string }[];
}

export function Locks() {
  const { isOwner, has, refreshReference } = useAuthed();
  const { data, error, reload } = useApi<LockState>('/api/periods');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [reopening, setReopening] = useState<string | null>(null);
  const mayLock = isOwner;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const name = (end: string) => (data.sells ? monthLabel(end.slice(0, 7)) : `the year to ${formatDate(end)}`);
  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setProblem('');
    try {
      await what();
      toast(done);
      await reload();
      await refreshReference();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Couldn’t change the lock');
    } finally {
      setBusy(false);
    }
  };
  const lock = (through: string) => run(() => api('/api/periods/lock', { body: { through } }), `Closed up to ${formatDate(through)}`);
  // The oldest month (or year) that has ended and is still open: closing it is the next month end.
  const nextToClose = [...data.periods].reverse().find((p) => p.ended && !p.locked) ?? null;

  return (
    <div className="stack">
      <section className="panel panel-pad stack-sm">
        <h3>{data.sells ? 'Month end and locks' : 'Locks'}</h3>
        <p className="small muted">
          {data.lockDate ? `The books are closed up to ${formatDate(data.lockDate)}: nothing dated on or before it can change.` : 'Nothing is locked yet.'}{' '}
          {data.sells
            ? 'A business that sells closes each month, so the takings, the VAT and the bank stay as they were checked.'
            : 'Close a year once your accountant has signed it off.'}{' '}
          To put something right in a closed period, reopen it with the reason (it’s kept with the books), then lock it again.
        </p>
        {data.reopened && (
          <div className="banner signal small stack-sm">
            <span>
              <strong>Reopened</strong>
              {data.lockDate ? ` from ${formatDate(data.lockDate)}` : ''}
              {data.reopened.byName ? ` by ${data.reopened.byName}` : ''}
              {data.reopened.at ? `, ${formatDate(String(data.reopened.at).slice(0, 10))}` : ''}: {data.reopened.reason}. It was closed up to {formatDate(data.reopened.relockDate)}.
            </span>
            {mayLock && (
              <div>
                <button type="button" className="btn small primary" disabled={busy} onClick={() => void lock(data.reopened!.relockDate)}>
                  Lock it again (up to {formatDate(data.reopened.relockDate)})
                </button>
              </div>
            )}
          </div>
        )}
        {problem && <div className="banner alert small">{problem}</div>}
        {mayLock && nextToClose && (
          <div className="row wrap">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void lock(nextToClose.end)}>
              Close {name(nextToClose.end)}
            </button>
          </div>
        )}
      </section>

      {data.sells && has('sales') && <MonthEndMode state={data} mayLock={mayLock} onSaved={() => void reload()} />}

      <div className="panel table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{data.sells ? 'Month' : 'Year'}</th>
              <th>State</th>
              {data.sells && <th className="num">Sales</th>}
              {data.sells && <th className="num">Refunds</th>}
              <th className="num">Other invoices</th>
              <th className="num">Costs</th>
              {has('bank') && <th className="num">Bank lines not ticked off</th>}
              {mayLock && <th />}
            </tr>
          </thead>
          <tbody>
            {data.periods.map((p) => (
              <tr key={p.end}>
                <td className="nowrap">{data.sells ? monthLabel(p.end.slice(0, 7)) : `To ${formatDate(p.end)}`}</td>
                <td className="small">{p.locked ? 'Closed' : p.ended ? <strong>Open</strong> : 'Under way'}</td>
                {data.sells && (
                  <td className="num">
                    <Money cents={p.salesCents} />
                    <div className="xs muted">{p.salesCount} sale{p.salesCount === 1 ? '' : 's'}</div>
                  </td>
                )}
                {data.sells && <td className="num">{p.refundsCents ? <Money cents={p.refundsCents} /> : ''}</td>}
                <td className="num">
                  <Money cents={p.invoicedCents} />
                </td>
                <td className="num">
                  <Money cents={p.costsCents} />
                </td>
                {has('bank') && <td className="num">{p.bankOpen || ''}</td>}
                {mayLock && (
                  <td className="nowrap">
                    {!p.locked && p.ended && (
                      <button type="button" className="btn small" disabled={busy} onClick={() => void lock(p.end)}>
                        Close up to here
                      </button>
                    )}
                    {p.locked && (
                      <button type="button" className="btn small quiet" disabled={busy} onClick={() => setReopening(p.end)}>
                        Reopen
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!data.periods.length && <Empty title="Nothing yet" />}
      </div>

      {reopening && (
        <Reopen
          period={reopening}
          label={name(reopening)}
          sells={data.sells}
          vatPeriods={data.vatPeriods}
          onCancel={() => setReopening(null)}
          onDone={async () => {
            setReopening(null);
            await reload();
            await refreshReference();
          }}
        />
      )}
    </div>
  );
}

/** The month (or year) ending `period` and everything after it opened again, with the reason. */
function Reopen({ period, label, sells, vatPeriods, onCancel, onDone }: { period: string; label: string; sells: boolean; vatPeriods: { start: string; end: string }[]; onCancel: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Closed up to the month (or year) before it.
  const to = sells ? previousMonthEnd(period) : previousYearEnd(period);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/periods/reopen', { body: { to, reason } });
      toast(`Reopened from ${label}`);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t reopen it');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel panel-pad stack-sm" onSubmit={submit}>
      <h3>Reopen {label}</h3>
      <p className="small muted">
        {label[0]!.toUpperCase() + label.slice(1)} and everything after it opens again, so it can be put right. The reason is kept with the books, with who reopened it. Lock it again once it’s done.
      </p>
      {vatPeriods.filter((p) => p.end > to).length > 0 && (
        <div className="banner signal small stack-sm">
          <span>
            <strong>VAT periods already ended:</strong>{' '}
            {vatPeriods
              .filter((p) => p.end > to)
              .reverse()
              .map((p) => `${formatDate(p.start)} to ${formatDate(p.end)}`)
              .join('; ')}
            . If a VAT201 for one is filed, a change to it means a revised VAT201 (ask your accountant). SARS doesn’t take more input tax by revising a past period: a supplier invoice that came in late is claimed in the current one, so capture it dated in an open period, not by reopening.
          </span>
        </div>
      )}
      <Field label="Why it’s reopened">{(p) => <input {...p} className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required placeholder="e.g. a supplier invoice dated in the month came in late" />}</Field>
      {error && <div className="banner alert small">{error}</div>}
      <div className="row">
        <button type="button" className="btn quiet" onClick={onCancel}>
          Back
        </button>
        <button className="btn primary grow" disabled={busy || reason.trim().length < 3}>
          Reopen
        </button>
      </div>
    </form>
  );
}

/** Month end: closed by hand, or each month locks itself on a day of the next. */
function MonthEndMode({ state, mayLock, onSaved }: { state: LockState; mayLock: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState(state.monthEnd.mode);
  const [day, setDay] = useState(state.monthEnd.day);
  const [error, setError] = useState('');
  const dirty = mode !== state.monthEnd.mode || day !== state.monthEnd.day;
  const save = async () => {
    setError('');
    try {
      await api('/api/periods/month-end', { method: 'PUT', body: { mode, day } });
      toast(mode === 'auto' ? `Each month locks itself on day ${day} of the next` : 'Each month is closed by hand');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <section className="panel panel-pad stack-sm">
      <h3>Month end</h3>
      <Segmented
        label="How each month is closed"
        value={mode}
        onChange={setMode}
        disabled={!mayLock}
        options={[
          { value: 'manual', label: 'By hand' },
          { value: 'auto', label: 'By itself' },
        ]}
      />
      <Field label={mode === 'auto' ? 'Day of the next month it locks' : 'Day of the next month Home reminds you'} hint="1 to 28">
        {(p) => <input {...p} className="input" type="number" min={1} max={28} value={day} disabled={!mayLock} onChange={(e) => setDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 100 }} />}
      </Field>
      {state.monthEnd.next && !dirty && (
        <p className="small muted">
          Next: {monthLabel(state.monthEnd.next.through.slice(0, 7))} locks itself on {formatDate(state.monthEnd.next.on)}, whether or not it’s been checked. You can close it earlier.
        </p>
      )}
      {error && <div className="banner alert small">{error}</div>}
      {mayLock && dirty && (
        <div>
          <button type="button" className="btn primary small" onClick={() => void save()}>
            Save
          </button>
        </div>
      )}
    </section>
  );
}

function previousMonthEnd(end: string): string {
  const d = new Date(`${end.slice(0, 8)}01T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

function previousYearEnd(end: string): string {
  const d = new Date(`${Number(end.slice(0, 4)) - 1}-${end.slice(5, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}
