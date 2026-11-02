/**
 * The time tracker: a clock to start and stop (one running at a time, across all jobs), time
 * added by hand, and what's been billed. Time goes onto an invoice from the invoice (Add time…).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, todayIso } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { hoursLabel, minutesSince } from '../lib/time';
import { Drawer, Empty, Field, Icon, Loading, Money, useToast } from './ui';

interface Entry {
  id: string;
  projectId: string | null;
  projectName: string | null;
  startedAt: string;
  endedAt: string | null;
  minutes: number | null;
  note: string;
  billedDocumentId: string | null;
  billedNumber: string | null;
}
export interface Running {
  id: string;
  projectId: string | null;
  projectName: string | null;
  startedAt: string;
  note: string;
}

/** Ticks once a minute so a running clock shows its time. */
export function useMinuteTick() {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
}

export async function startClock(projectId: string | null, note = '') {
  return api<Running>('/api/time/start', { body: { projectId, note } });
}
export async function stopClock() {
  return api('/api/time/stop', { body: {} });
}

export function JobTime({ projectId, rateCents, canEdit }: { projectId: string; rateCents: number; canEdit: boolean }) {
  const toast = useToast();
  const { data, loading, reload } = useApi<{ entries: Entry[]; running: Running | null }>(`/api/time?project=${projectId}`);
  const [edit, setEdit] = useState<Entry | 'new' | null>(null);
  const [note, setNote] = useState('');
  useMinuteTick();
  const running = data?.running;
  const here = running?.projectId === projectId;
  const unbilled = (data?.entries ?? []).filter((e) => e.endedAt && !e.billedDocumentId).reduce((s, e) => s + (e.minutes ?? 0), 0);

  const go = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      setNote('');
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t do that', 'error');
    }
  };

  if (loading && !data) return <Loading />;
  return (
    <div className="stack">
      <section className="panel panel-pad stack">
        {here ? (
          <div className="row wrap spread">
            <span>
              <strong className="timer-on">● {hoursLabel(minutesSince(running!.startedAt))}</strong>
              <div className="xs muted">Clock running since {new Date(running!.startedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}{running!.note ? ` · ${running!.note}` : ''}</div>
            </span>
            {canEdit && (
              <button className="btn primary" onClick={() => void go(stopClock, 'Clock stopped')}>
                Stop
              </button>
            )}
          </div>
        ) : (
          canEdit && (
            <div className="row wrap">
              <input className="input grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you’re doing (optional)" aria-label="Note" />
              <button className="btn primary" onClick={() => void go(() => startClock(projectId, note), running ? `Clock moved from ${running.projectName ?? 'the other job'}` : 'Clock started')}>
                <Icon name="clock" size={18} />
                Start the clock
              </button>
            </div>
          )
        )}
        {running && !here && <p className="xs muted">The clock is running on {running.projectName ?? 'time with no job'}: starting it here stops that one.</p>}
        <p className="small">
          Not invoiced yet: <strong>{hoursLabel(unbilled)}</strong>
          {rateCents > 0 ? (
            <>
              {' '}
              · <Money cents={Math.round((unbilled / 60) * rateCents)} /> at <Money cents={rateCents} /> an hour
            </>
          ) : (
            <span className="muted"> · set an hourly rate on the job, or your usual rate in Settings → Invoicing &amp; tax, to bill it</span>
          )}
        </p>
        <p className="xs muted">To bill it, open an invoice for this job and tap “Add time…”.</p>
      </section>
      <section className="panel">
        <div className="panel-head spread">
          <strong>Time logged</strong>
          {canEdit && (
            <button className="btn small" onClick={() => setEdit('new')}>
              <Icon name="plus" size={14} />
              Add time
            </button>
          )}
        </div>
        {data?.entries.length ? (
          <ul className="list">
            {data.entries.map((e) => (
              <li key={e.id} className={`list-row ${canEdit && !e.billedDocumentId && e.endedAt ? 'clickable' : ''}`} onClick={() => canEdit && !e.billedDocumentId && e.endedAt && setEdit(e)}>
                <span className="grow small">
                  {formatDate(e.startedAt.slice(0, 10))}
                  {e.note && <span className="muted"> · {e.note}</span>}
                  {e.billedNumber && (
                    <div className="xs">
                      On <Link to={`/documents/${e.billedDocumentId}`} onClick={(ev) => ev.stopPropagation()}>{e.billedNumber}</Link>
                    </div>
                  )}
                </span>
                <span className="small nowrap">{e.endedAt ? hoursLabel(e.minutes ?? 0) : 'running'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No time logged yet">Start the clock when you start working, or add time afterwards.</Empty>
        )}
      </section>
      {edit && <TimeEntryDrawer entry={edit === 'new' ? null : edit} projectId={projectId} onClose={() => setEdit(null)} onSaved={reload} />}
    </div>
  );
}

const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function TimeEntryDrawer({ entry, projectId, onClose, onSaved }: { entry: Entry | null; projectId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(entry ? localInput(entry.startedAt).slice(0, 10) : todayIso());
  const [from, setFrom] = useState(entry ? localInput(entry.startedAt).slice(11) : '08:00');
  const [to, setTo] = useState(entry?.endedAt ? localInput(entry.endedAt).slice(11) : '10:00');
  const [note, setNote] = useState(entry?.note ?? '');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const startedAt = new Date(`${date}T${from}`);
    const endedAt = new Date(`${date}T${to}`);
    if (endedAt <= startedAt) endedAt.setDate(endedAt.getDate() + 1); // past midnight
    const body = { projectId, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), note };
    try {
      if (entry) await api(`/api/time/${entry.id}`, { method: 'PUT', body });
      else await api('/api/time', { body });
      toast('Time saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  const remove = async () => {
    if (!entry || !confirm('Delete this time?')) return;
    await api(`/api/time/${entry.id}`, { method: 'DELETE' });
    onSaved();
    onClose();
  };
  return (
    <Drawer title={entry ? 'Time' : 'Add time'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Date">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
        <div className="form-grid">
          <Field label="From">{(p) => <input {...p} className="input" type="time" value={from} onChange={(e) => setFrom(e.target.value)} required />}</Field>
          <Field label="To">{(p) => <input {...p} className="input" type="time" value={to} onChange={(e) => setTo(e.target.value)} required />}</Field>
        </div>
        <Field label="Note (optional)">{(p) => <input {...p} className="input" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
        {entry && (
          <button type="button" className="btn quiet block" onClick={() => void remove()}>
            Delete
          </button>
        )}
      </form>
    </Drawer>
  );
}
