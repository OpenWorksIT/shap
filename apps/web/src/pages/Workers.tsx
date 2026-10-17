import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatDate, formatZar, WORKER_KIND_LABELS, WORKER_KINDS, type WorkerKind } from '@shap/shared';
import { ProjectSelect } from '../components/Pickers';
import { PageHead } from '../components/Shell';
import { Avatar, Drawer, Empty, ErrorBox, Field, Icon, Loading, Money, MoneyInput, Tabs, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { LabourEntry, WorkerRow } from '../lib/types';

type Tab = 'people' | 'allocate';

export default function WorkersPage() {
  const { isOwner } = useAuthed();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'people';
  const workers = useApi<WorkerRow[]>('/api/workers');
  const unallocated = useApi<LabourEntry[]>('/api/labour/unallocated');
  const [adding, setAdding] = useState(false);
  const owed = (workers.data ?? []).reduce((s, w) => s + w.balanceCents, 0);

  return (
    <div className="stack-lg">
      <PageHead
        title="Workers"
        sub={workers.data ? `Net ${owed >= 0 ? 'owed to workers' : 'advanced to workers'}: ${formatZar(Math.abs(owed))}` : undefined}
        actions={
          isOwner && (
            <>
              <Link to="/log?tab=pay" className="btn">
                <Icon name="money" size={18} />
                Pay
              </Link>
              <button className="btn primary" onClick={() => setAdding(true)}>
                <Icon name="plus" size={18} />
                Add worker
              </button>
            </>
          )
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={(t) => setParams({ tab: t }, { replace: true })}
        tabs={[
          { value: 'people', label: 'People' },
          { value: 'allocate', label: 'Allocate', count: unallocated.data?.length },
        ]}
      />
      {tab === 'people' && (
        <>
          <ErrorBox error={workers.error} onRetry={workers.reload} />
          {!workers.data ? (
            <Loading />
          ) : (
            <div className="panel table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th className="num hide-sm">Day rate</th>
                    <th className="num hide-sm">Days this month</th>
                    <th className="num">Owed / (advance)</th>
                    <th className="num hide-md">Savings held</th>
                    <th className="hide-md">Last worked</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.data.map((w) => (
                    <tr key={w.id} className={w.active ? '' : 'inactive'}>
                      <td>
                        <Link to={`/workers/${w.id}`} className="row" style={{ gap: 10 }}>
                          <Avatar name={w.name} size={30} />
                          <span>
                            <strong>{w.name}</strong>
                            <div className="xs muted">
                              {WORKER_KIND_LABELS[w.kind]}
                              {w.active ? '' : ' · not active'}
                            </div>
                          </span>
                        </Link>
                      </td>
                      <td className="num hide-sm">
                        <Money cents={w.dayRateCents || null} whole />
                        {w.allowanceCents > 0 && <div className="xs muted">+ {formatZar(w.allowanceCents, { cents: false })}</div>}
                      </td>
                      <td className="num hide-sm">{w.daysThisMonth || '–'}</td>
                      <td className={`num ${w.balanceCents < 0 ? 'muted' : w.balanceCents > 0 ? 'strong' : ''}`}>{w.balanceCents === 0 ? '–' : w.balanceCents > 0 ? formatZar(w.balanceCents) : `(${formatZar(-w.balanceCents)})`}</td>
                      <td className="num hide-md">
                        <Money cents={w.savingsCents || null} />
                      </td>
                      <td className="hide-md">{formatDate(w.lastWorked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="xs muted panel-pad">Owed is what they’ve earned and not been paid yet. Brackets mean you’ve paid ahead (an advance).</p>
            </div>
          )}
        </>
      )}
      {tab === 'allocate' && <Allocate entries={unallocated.data} canEdit={isOwner} onDone={() => (void unallocated.reload(), void workers.reload())} />}
      {adding && <WorkerDrawer onClose={() => setAdding(false)} onSaved={workers.reload} />}
    </div>
  );
}

/** Days logged without a job: tick them, choose the job or the general-work type, done. */
function Allocate({ entries, canEdit, onDone }: { entries: LabourEntry[] | null; canEdit: boolean; onDone: () => void }) {
  const { ref } = useAuthed();
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workTypeId, setWorkTypeId] = useState<string | null>(null);
  const total = useMemo(() => (entries ?? []).filter((e) => picked.has(e.id)).reduce((s, e) => s + e.wageCents + e.allowanceCents, 0), [entries, picked]);
  if (!entries) return <Loading />;
  if (!entries.length)
    return (
      <div className="panel">
        <Empty title="Nothing to allocate">Every day of labour is on a job or a type of general work.</Empty>
      </div>
    );
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const apply = async () => {
    try {
      const r = await api<{ updated: number }>('/api/labour/allocate', { body: { ids: [...picked], projectId, workTypeId: projectId ? null : workTypeId } });
      toast(`${r.updated} day${r.updated === 1 ? '' : 's'} allocated`);
      setPicked(new Set());
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t allocate', 'error');
    }
  };
  return (
    <div className="stack">
      <div className="banner small">These days were logged without a job. Until they’re allocated they count as general labour, a running cost, so no job’s profit includes them.</div>
      <section className="panel table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input type="checkbox" aria-label="Select all" checked={picked.size === entries.length} onChange={(e) => setPicked(e.target.checked ? new Set(entries.map((x) => x.id)) : new Set())} />
              </th>
              <th>Date</th>
              <th>Worker</th>
              <th className="num">Days</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="clickable" onClick={() => toggle(e.id)}>
                <td>
                  <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} onClick={(x) => x.stopPropagation()} aria-label={`Select ${e.workerName} ${e.date}`} />
                </td>
                <td className="nowrap">{formatDate(e.date)}</td>
                <td>
                  {e.workerName}
                  {e.note && <div className="xs muted">{e.note}</div>}
                </td>
                <td className="num">{e.days}</td>
                <td className="num">
                  <Money cents={e.wageCents + e.allowanceCents} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {canEdit && (
        <section className="panel panel-pad sticky-bar">
          <div className="form-grid">
            <Field label="Put on a job">{(p) => <ProjectSelect {...p} value={projectId} onChange={(v) => (setProjectId(v), v && setWorkTypeId(null))} emptyLabel="Choose a job…" />}</Field>
            <Field label="…or general work">
              {(p) => (
                <select {...p} className="select" value={workTypeId ?? ''} onChange={(e) => (setWorkTypeId(e.target.value || null), e.target.value && setProjectId(null))}>
                  <option value="">Choose…</option>
                  {ref.workTypes.filter((w) => w.active).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <button className="btn primary big block" style={{ marginTop: 12 }} disabled={!picked.size || (!projectId && !workTypeId)} onClick={() => void apply()}>
            Allocate {picked.size || ''} day{picked.size === 1 ? '' : 's'}
            {picked.size ? ` · ${formatZar(total, { cents: false })}` : ''}
          </button>
        </section>
      )}
    </div>
  );
}

export function WorkerDrawer({ worker, onClose, onSaved }: { worker?: WorkerRow; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: worker?.name ?? '',
    kind: (worker?.kind ?? 'permanent') as WorkerKind,
    dayRateCents: worker?.dayRateCents ?? 0,
    allowanceCents: worker?.allowanceCents ?? 0,
    phone: worker?.phone ?? '',
    notes: worker?.notes ?? '',
    active: worker?.active ?? true,
  });
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (worker) await api(`/api/workers/${worker.id}`, { method: 'PUT', body: f });
      else await api('/api/workers', { body: f });
      toast('Saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title={worker ? worker.name : 'Add a worker'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">{(p) => <input {...p} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus />}</Field>
        <Field label="Kind">
          {(p) => (
            <select {...p} className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as WorkerKind })}>
              {WORKER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {WORKER_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="form-grid">
          <Field label="Day rate" hint="Used for new days. Past days keep what they were.">{(p) => <MoneyInput {...p} value={f.dayRateCents} onChange={(c) => setF({ ...f, dayRateCents: c ?? 0 })} />}</Field>
          <Field label="Daily allowance" hint="Transport or lunch">{(p) => <MoneyInput {...p} value={f.allowanceCents} onChange={(c) => setF({ ...f, allowanceCents: c ?? 0 })} />}</Field>
        </div>
        <Field label="Phone">{(p) => <input {...p} className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
        <Field label="Notes">{(p) => <textarea {...p} className="textarea" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
        {worker && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            Still working with us (shows in the crew list)
          </label>
        )}
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
      </form>
    </Drawer>
  );
}
