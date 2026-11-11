/**
 * Locks (Shap's docs/LOCKS.md): what's closed, and month end for a business that sells. Everything
 * dated on or before the lock date is closed; the owner locks a month or a year, and reopens the
 * books with the reason to put something right, then locks them again. Month end is closed by hand, or each month locks itself
 * on a day of the next.
 */
import { useState, type FormEvent } from 'react';
import { addDays, formatDate, monthLabel, vatLockDayLate } from '@shap/shared';
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
  /** Credit notes issued in the period (a sale's refund's included). */
  creditedCents: number;
  costsCents: number;
  bankOpen: number;
}
export interface LockState {
  lockDate: string | null;
  reopened: { relockDate: string; at: string | null; byName: string | null; reason: string } | null;
  sells: boolean;
  /** Closed as it goes: each month (it sells), each VAT period (a VAT vendor that doesn't), or each year. */
  closes: 'month' | 'vat' | 'year';
  monthEnd: { mode: 'manual' | 'auto'; day: number; next: { on: string; through: string; closesYears?: string[] } | null };
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
  const [reopening, setReopening] = useState<{ start: string; end: string } | null>(null);
  const mayLock = isOwner;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const name = (p: { start: string; end: string }) => (data.closes === 'year' ? `the year to ${formatDate(p.end)}` : data.closes === 'vat' ? `the VAT period ${spanLabel(p, true)}` : spanLabel(p));
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
        <h3>{data.closes === 'month' ? 'Month end and locks' : data.closes === 'vat' ? 'VAT period end and locks' : 'Locks'}</h3>
        <p className="small muted">
          {data.lockDate ? `The books are closed up to ${formatDate(data.lockDate)}: nothing dated on or before it can change.` : 'Nothing is locked yet.'}{' '}
          {data.closes === 'month'
            ? 'A business that sells closes each month, so the takings, the VAT and the bank stay as they were checked.'
            : data.closes === 'vat'
              ? 'Shap closes a VAT-registered business’s books one VAT period at a time, so what the VAT201 was worked out from stays as it was when the period closed. The year end closes with the year’s last VAT period: your accountant’s year-end journals after that need a reopen.'
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
              Close {name(nextToClose)}
            </button>
          </div>
        )}
      </section>

      {(data.closes === 'vat' || (data.closes === 'month' && has('sales'))) && <MonthEndMode state={data} mayLock={mayLock} onSaved={() => void reload()} />}

      <div className="panel table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{data.closes === 'month' ? 'Month' : data.closes === 'vat' ? 'VAT period' : 'Year'}</th>
              <th>State</th>
              {data.sells && <th className="num">Sales</th>}
              {data.sells && <th className="num">Refunds</th>}
              <th className="num">Other invoices</th>
              <th className="num hide-sm">Credit notes</th>
              <th className="num">Costs</th>
              {has('bank') && <th className="num">Bank lines not ticked off</th>}
              {mayLock && <th />}
            </tr>
          </thead>
          <tbody>
            {data.periods.map((p) => (
              <tr key={p.end}>
                <td className="nowrap">{data.closes === 'year' ? `To ${formatDate(p.end)}` : spanLabel(p)}</td>
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
                <td className="num hide-sm">{p.creditedCents ? <Money cents={p.creditedCents} /> : ''}</td>
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
                      <button type="button" className="btn small quiet" disabled={busy} onClick={() => setReopening(p)}>
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

/** The month (VAT period, year) `period` and everything after it opened again, with the reason. */
function Reopen({ period, label, vatPeriods, onCancel, onDone }: { period: { start: string; end: string }; label: string; vatPeriods: { start: string; end: string }[]; onCancel: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Closed up to the period before it.
  const to = addDays(period.start, -1);
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
            . Not filed yet: put it right, lock it again, then file. Filed: a change to it means a revised VAT201 (ask your accountant); a supplier invoice that came in late can be claimed in a later return instead, within five years (VAT Act s16(3)): Shap puts a cost’s VAT in the period it’s dated in, so capture it dated in an open period. Across a year end, your accountant says how it goes in the books.
          </span>
        </div>
      )}
      <Field label="Why it’s reopened">{(p) => <input {...p} className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required placeholder="e.g. a cost was captured on the wrong date" />}</Field>
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

/** Month end (VAT period end): closed by hand, or each locks itself on a day of the month after it. */
function MonthEndMode({ state, mayLock, onSaved }: { state: LockState; mayLock: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState(state.monthEnd.mode);
  const [day, setDay] = useState(state.monthEnd.day);
  const [error, setError] = useState('');
  const dirty = mode !== state.monthEnd.mode || day !== state.monthEnd.day;
  const vat = state.closes === 'vat';
  const each = vat ? 'Each VAT period' : 'Each month';
  const [closesYears, setClosesYears] = useState('');
  const save = async (closeYears = false) => {
    setError('');
    try {
      await api('/api/periods/month-end', { method: 'PUT', body: { mode, day, ...(closeYears ? { closeYears } : {}) } });
      setClosesYears('');
      toast(mode === 'auto' ? `${each} locks itself on day ${day} of the month after it` : `${each} is closed by hand`);
      onSaved();
    } catch (err) {
      // Locking by itself would close a year not yet agreed or approved: say so, and ask.
      if (err instanceof ApiError && err.code === 'closes_year') setClosesYears(err.message);
      else setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <section className="panel panel-pad stack-sm">
      <h3>{vat ? 'VAT period end' : 'Month end'}</h3>
      <Segmented
        label={vat ? 'How each VAT period is closed' : 'How each month is closed'}
        value={mode}
        onChange={setMode}
        disabled={!mayLock}
        options={[
          { value: 'manual', label: 'By hand' },
          { value: 'auto', label: 'By itself' },
        ]}
      />
      <Field label={vat ? (mode === 'auto' ? 'Day of the month after the period that it locks' : 'Day of the month after the period that Home reminds you') : mode === 'auto' ? 'Day of the next month it locks' : 'Day of the next month Home reminds you'} hint={vat ? '1 to 28. Pick a day before your VAT201 is due (on eFiling, the last business day of the month after the period; otherwise the 25th), so it’s worked out from closed books.' : '1 to 28'}>
        {(p) => <input {...p} className="input" type="number" min={1} max={28} value={day} disabled={!mayLock} onChange={(e) => setDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 100 }} />}
      </Field>
      {vat && vatLockDayLate(day) && <p className="xs warn-text">After the 25th: a VAT201 filed other than on eFiling is due by the 25th, and in some months eFiling’s due date comes before the 28th.</p>}
      {state.monthEnd.next && !dirty && (
        <p className="small muted">
          Next: {vat ? `the VAT period ending ${formatDate(state.monthEnd.next.through)}` : monthLabel(state.monthEnd.next.through.slice(0, 7))} locks itself on {formatDate(state.monthEnd.next.on)}, whether or not it’s been checked. You can close it earlier.
          {state.monthEnd.next.closesYears?.length ? ` That closes the year to ${state.monthEnd.next.closesYears.map((e) => formatDate(e)).join(' and the year to ')}, not yet agreed with your accountant: get their year-end journals in first, or close by hand until then.` : ''}
        </p>
      )}
      {error && <div className="banner alert small">{error}</div>}
      {closesYears && (
        <div className="banner signal small stack-sm">
          <span>{closesYears}</span>
          <div className="row wrap">
            <button type="button" className="btn small" onClick={() => void save(true)}>
              Lock by itself anyway
            </button>
            <button type="button" className="btn small quiet" onClick={() => (setClosesYears(''), setMode('manual'))}>
              Keep closing by hand
            </button>
          </div>
        </div>
      )}
      {mayLock && dirty && !closesYears && (
        <div>
          <button type="button" className="btn primary small" onClick={() => void save()}>
            Save
          </button>
        </div>
      )}
    </section>
  );
}

/** A month ("Mar 26"), or a VAT period of months ("Jan to Feb 26"); `fullYear` on a button ("Jan to Feb 2026"). */
function spanLabel(p: { start: string; end: string }, fullYear = false): string {
  const label = (ym: string, year: boolean) => (fullYear && year ? `${monthLabel(ym, false)} ${ym.slice(0, 4)}` : monthLabel(ym, year));
  const to = label(p.end.slice(0, 7), true);
  if (p.start.slice(0, 7) === p.end.slice(0, 7)) return to;
  return `${label(p.start.slice(0, 7), p.start.slice(0, 4) !== p.end.slice(0, 4))} to ${to}`;
}
