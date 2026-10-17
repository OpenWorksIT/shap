import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatDate, formatZar, todayIso } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useAuthed } from '../lib/session';
import type { LabourEntry, WorkerRow } from '../lib/types';
import { ProjectSelect, useWorkers } from './Pickers';
import { Field, Icon, MoneyInput, Segmented, useToast } from './ui';

type Target = 'job' | 'general' | 'later';
interface Pick {
  days: number;
  wageCents: number;
  allowanceCents: number;
}

/**
 * Log a day for the crew in one go: pick the job (or the kind of general work), tap the
 * workers who were there. Rates fill in from each worker; the owner can change them.
 */
export function LabourForm({ projectId: fixedProject, onSaved }: { projectId?: string; onSaved?: () => void }) {
  const { isOwner, seesMoney, ref } = useAuthed();
  const toast = useToast();
  const workers = useWorkers();
  const [date, setDate] = useState(todayIso());
  const [target, setTarget] = useState<Target>('job');
  const [projectId, setProjectId] = useState<string | null>(fixedProject ?? null);
  const [workTypeId, setWorkTypeId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, Pick>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useMemo(() => (workers.data ?? []).filter((w) => w.active), [workers.data]);

  const toggle = (w: WorkerRow) =>
    setPicked((p) => {
      const next = { ...p };
      if (next[w.id]) delete next[w.id];
      else next[w.id] = { days: 1, wageCents: w.dayRateCents ?? 0, allowanceCents: w.allowanceCents ?? 0 };
      return next;
    });
  const setDays = (w: WorkerRow, days: number) =>
    setPicked((p) => {
      const cur = p[w.id]!;
      // Keep the wage in step with the days unless it was typed by hand.
      const rate = w.dayRateCents ?? 0;
      const auto = Math.round(rate * cur.days) === cur.wageCents;
      return { ...p, [w.id]: { ...cur, days, wageCents: auto ? Math.round(rate * days) : cur.wageCents } };
    });

  useEffect(() => {
    if (fixedProject) setProjectId(fixedProject);
  }, [fixedProject]);

  const ids = Object.keys(picked);
  const total = ids.reduce((s, id) => s + picked[id]!.wageCents + picked[id]!.allowanceCents, 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (target === 'job' && !projectId) return setError('Pick the job, or choose General work');
    if (target === 'general' && !workTypeId) return setError('Pick the kind of general work');
    if (!ids.length) return setError('Tap the workers who were there');
    setBusy(true);
    try {
      await api('/api/labour', {
        body: {
          date,
          projectId: target === 'job' ? projectId : null,
          workTypeId: target === 'general' ? workTypeId : null,
          note,
          entries: ids.map((id) => ({ workerId: id, ...picked[id]! })),
        },
      });
      const where = target === 'later' ? ' (to allocate later)' : '';
      toast(`Logged ${ids.length} worker${ids.length === 1 ? '' : 's'} for ${formatDate(date)}${where}`);
      setPicked({});
      setNote('');
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Date">{(p) => <input {...p} className="input" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} required />}</Field>
        {!fixedProject && (
          <div className="field">
            <span className="label">Where</span>
            <Segmented<Target>
              label="Where was the work"
              value={target}
              onChange={setTarget}
              options={[
                { value: 'job', label: 'On a job' },
                { value: 'general', label: 'General work' },
                { value: 'later', label: 'Sort later' },
              ]}
            />
          </div>
        )}
      </div>
      {target === 'job' && !fixedProject && <Field label="Job">{(p) => <ProjectSelect {...p} value={projectId} onChange={setProjectId} emptyLabel="Choose the job…" />}</Field>}
      {target === 'general' && (
        <Field label="Kind of general work" hint="Yard days, quoting, fetching stock: counted as a running cost, not lost.">
          {(p) => (
            <select {...p} className="select" value={workTypeId ?? ''} onChange={(e) => setWorkTypeId(e.target.value || null)}>
              <option value="">Choose…</option>
              {ref.workTypes.filter((w) => w.active).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {target === 'later' && <div className="banner small">These days go to the <strong>Allocate</strong> list on Workers, so you can put them on a job later.</div>}

      <div className="field">
        <span className="label">Who worked</span>
        {workers.loading && !workers.data ? (
          <span className="small muted">Loading workers…</span>
        ) : (
          <div className="crew">
            {active.map((w) => {
              const p = picked[w.id];
              return (
                <div key={w.id} className={`crew-member ${p ? 'on' : ''}`}>
                  <button type="button" className="crew-toggle" onClick={() => toggle(w)} aria-pressed={Boolean(p)}>
                    <span className="tick">{p && <Icon name="check" size={16} />}</span>
                    <span className="grow">
                      <strong>{w.name}</strong>
                      {seesMoney && w.dayRateCents > 0 && (
                        <span className="xs muted" style={{ display: 'block' }}>
                          {formatZar(w.dayRateCents, { cents: false })}/day{w.allowanceCents ? ` + ${formatZar(w.allowanceCents, { cents: false })}` : ''}
                        </span>
                      )}
                    </span>
                  </button>
                  {p && (
                    <div className="crew-detail">
                      <Segmented<string>
                        label={`Days for ${w.name}`}
                        value={String(p.days)}
                        onChange={(v) => setDays(w, Number(v))}
                        options={[
                          { value: '0.5', label: '½ day' },
                          { value: '1', label: '1 day' },
                        ]}
                      />
                      {isOwner && (
                        <div className="row" style={{ gap: 6 }}>
                          <MoneyInput value={p.wageCents} onChange={(c) => setPicked((x) => ({ ...x, [w.id]: { ...x[w.id]!, wageCents: c ?? 0 } }))} aria-describedby="" />
                          <span className="xs muted">+</span>
                          <MoneyInput value={p.allowanceCents} onChange={(c) => setPicked((x) => ({ ...x, [w.id]: { ...x[w.id]!, allowanceCents: c ?? 0 } }))} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {!active.length && <span className="small muted">No workers yet. Add them under Workers.</span>}
          </div>
        )}
        {isOwner && <span className="hint">Wage + allowance per person. Change them here for a one-off; change the worker’s rate for good.</span>}
      </div>
      <Field label="Note (optional)">{(p) => <input {...p} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. waiting for the concrete truck" />}</Field>
      {error && <div className="banner alert small">{error}</div>}
      <button className="btn primary big block" disabled={busy}>
        {busy ? 'Saving…' : ids.length ? `Log ${ids.length} worker${ids.length === 1 ? '' : 's'}${seesMoney ? ` · ${formatZar(total, { cents: false })}` : ''}` : 'Log the day'}
      </button>
    </form>
  );
}

/** Edit one labour entry (owner, or site capture on its own entries for a day). */
export function LabourEntryForm({ entry, onSaved, onDeleted }: { entry: LabourEntry; onSaved: () => void; onDeleted: () => void }) {
  const { ref, isOwner } = useAuthed();
  const toast = useToast();
  const workers = useWorkers();
  const [form, setForm] = useState({ ...entry });
  const [error, setError] = useState('');
  const set = <K extends keyof LabourEntry>(k: K, v: LabourEntry[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/labour/${entry.id}`, {
        method: 'PUT',
        body: { date: form.date, workerId: form.workerId, projectId: form.projectId, workTypeId: form.projectId ? null : form.workTypeId, days: Number(form.days), wageCents: form.wageCents, allowanceCents: form.allowanceCents, note: form.note },
      });
      toast('Saved');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  const del = async () => {
    if (!confirm('Delete this labour entry?')) return;
    try {
      await api(`/api/labour/${entry.id}`, { method: 'DELETE' });
      toast('Deleted');
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t delete');
    }
  };
  return (
    <form className="stack" onSubmit={save}>
      <div className="form-grid">
        <Field label="Date">{(p) => <input {...p} className="input" type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />}</Field>
        <Field label="Worker">
          {(p) => (
            <select {...p} className="select" value={form.workerId} onChange={(e) => set('workerId', e.target.value)}>
              {(workers.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field label="Job">{(p) => <ProjectSelect {...p} value={form.projectId} onChange={(v) => set('projectId', v)} emptyLabel="Not on a job" />}</Field>
      {!form.projectId && (
        <Field label="General work">
          {(p) => (
            <select {...p} className="select" value={form.workTypeId ?? ''} onChange={(e) => set('workTypeId', e.target.value || null)}>
              <option value="">Not allocated yet</option>
              {ref.workTypes.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div className="form-grid">
        <Field label="Days">{(p) => <input {...p} className="input" type="number" step="0.5" min="0" value={form.days} onChange={(e) => set('days', Number(e.target.value))} />}</Field>
        {isOwner && <Field label="Wage">{(p) => <MoneyInput {...p} value={form.wageCents} onChange={(c) => set('wageCents', c ?? 0)} />}</Field>}
        {isOwner && <Field label="Allowance">{(p) => <MoneyInput {...p} value={form.allowanceCents} onChange={(c) => set('allowanceCents', c ?? 0)} />}</Field>}
      </div>
      <Field label="Note">{(p) => <input {...p} className="input" value={form.note} onChange={(e) => set('note', e.target.value)} />}</Field>
      {error && <div className="banner alert small">{error}</div>}
      <div className="row">
        <button className="btn primary">Save</button>
        <button type="button" className="btn danger" onClick={() => void del()}>
          Delete
        </button>
      </div>
    </form>
  );
}
