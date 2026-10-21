import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatDate, formatZar, todayIso, vatIncluded } from '@shap/shared';
import { api, ApiError, apiUrl } from '../lib/api';
import { shrinkImage } from '../lib/files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { CostRow, PlannedItem } from '../lib/types';
import { ProjectSelect } from './Pickers';
import { Field, Icon, MoneyInput, useToast } from './ui';

export interface CostDraft {
  id?: string;
  date: string;
  description: string;
  amountCents: number | null;
  vatCents: number;
  supplier: string;
  categoryId: string;
  sourceId: string | null;
  projectId: string | null;
  plannedItemId: string | null;
  receiptId: string | null;
  note: string;
}

export function costDraftFrom(c: CostRow): CostDraft {
  return {
    id: c.id,
    date: c.date,
    description: c.description,
    amountCents: c.amountCents,
    vatCents: c.vatCents,
    supplier: c.supplier,
    categoryId: c.categoryId,
    sourceId: c.sourceId,
    projectId: c.projectId,
    plannedItemId: c.plannedItemId,
    receiptId: c.receiptId,
    note: c.note,
  };
}

/** Add or change a cost. On a phone: amount first, a photo of the slip, then the details. */
export function CostForm({ initial, projectId, plannedItem, onSaved, onDeleted }: { initial?: CostDraft; projectId?: string; plannedItem?: PlannedItem; onSaved?: () => void; onDeleted?: () => void }) {
  const { ref, settings, isOwner } = useAuthed();
  const toast = useToast();
  const suppliers = useApi<string[]>('/api/costs/suppliers');
  const cats = ref.categories.filter((c) => c.active || c.id === initial?.categoryId);
  const sources = ref.sources.filter((s) => s.active || s.id === initial?.sourceId);
  const fresh = (): CostDraft => ({
    date: todayIso(),
    description: plannedItem?.description ?? '',
    amountCents: plannedItem ? plannedItem.totalCents : null,
    vatCents: 0,
    supplier: plannedItem?.supplier ?? '',
    categoryId: (plannedItem?.category === 'demo' ? cats.find((c) => c.kind === 'demo') : cats.find((c) => c.kind === 'materials'))?.id ?? cats[0]?.id ?? '',
    sourceId: settings.defaultCostSourceId ?? sources[0]?.id ?? '',
    projectId: projectId ?? null,
    plannedItemId: plannedItem?.id ?? null,
    receiptId: null,
    note: '',
  });
  const [f, setF] = useState<CostDraft>(initial ?? fresh());
  const [vatAuto, setVatAuto] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof CostDraft>(k: K, v: CostDraft[K]) => setF((x) => ({ ...x, [k]: v }));
  const category = cats.find((c) => c.id === f.categoryId);
  const isJobCost = category?.kind === 'materials' || category?.kind === 'demo';

  const planned = useApi<{ planned: PlannedItem[] }>(f.projectId && isOwner ? `/api/projects/${f.projectId}` : null);
  const openPlanned = useMemo(() => (planned.data?.planned ?? []).filter((p) => !p.costId || p.id === f.plannedItemId), [planned.data, f.plannedItemId]);

  useEffect(() => {
    if (settings.vatRegistered && vatAuto) set('vatCents', f.amountCents ? vatIncluded(f.amountCents, settings.vatRateBp) : 0);
  }, [f.amountCents, vatAuto, settings.vatRegistered, settings.vatRateBp]);

  const photo = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const shrunk = await shrinkImage(file);
      const r = await api<{ id: string }>('/api/attachments', { body: shrunk });
      set('receiptId', r.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t upload the photo', 'error');
    } finally {
      setUploading(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (f.amountCents == null || f.amountCents === 0) return setError('Enter the amount');
    setBusy(true);
    try {
      const body = { ...f, amountCents: f.amountCents, description: f.description.trim() || category?.name || 'Cost', projectId: f.projectId, plannedItemId: f.projectId ? f.plannedItemId : null };
      if (f.id) await api(`/api/costs/${f.id}`, { method: 'PUT', body });
      else await api('/api/costs', { body });
      toast(f.id ? 'Cost saved' : 'Cost added');
      if (!f.id) {
        const keep = { date: f.date, sourceId: f.sourceId, projectId: f.projectId, categoryId: f.categoryId, supplier: f.supplier };
        setF({ ...fresh(), ...keep, plannedItemId: null });
      }
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!f.id || !confirm('Delete this cost?')) return;
    try {
      await api(`/api/costs/${f.id}`, { method: 'DELETE' });
      toast('Cost deleted');
      onDeleted?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t delete');
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Amount paid" hint={settings.vatRegistered ? 'Including VAT, as on the slip' : undefined}>
          {(p) => <MoneyInput {...p} value={f.amountCents} onChange={(c) => set('amountCents', c)} allowNegative autoFocus={!initial} />}
        </Field>
        <Field label="Date">{(p) => <input {...p} className="input" type="date" value={f.date} onChange={(e) => set('date', e.target.value)} required />}</Field>
      </div>
      <div className="form-grid">
        <Field label="What for">
          {(p) => (
            <select {...p} className="select" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Paid from">
          {(p) => (
            <select {...p} className="select" value={f.sourceId ?? ''} onChange={(e) => set('sourceId', e.target.value || null)}>
              <option value="">Not sure yet (capture later)</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field label={isJobCost ? 'Job' : 'Job (optional)'} hint={isJobCost && !f.projectId ? 'Parts without a job can’t be charged on. Pick the job if you know it.' : undefined}>
        {(p) => <ProjectSelect {...p} value={f.projectId} onChange={(v) => setF((x) => ({ ...x, projectId: v, plannedItemId: null }))} emptyLabel={isJobCost ? 'Choose the job…' : 'Not for a job'} />}
      </Field>
      {isOwner && f.projectId && openPlanned.length > 0 && (
        <Field label="Planned part (optional)" hint="Ticks it off the job’s parts list.">
          {(p) => (
            <select {...p} className="select" value={f.plannedItemId ?? ''} onChange={(e) => set('plannedItemId', e.target.value || null)}>
              <option value="">Not on the plan</option>
              {openPlanned.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.description}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div className="form-grid">
        <Field label="Description">{(p) => <input {...p} className="input" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder={category?.kind === 'materials' ? 'e.g. Cement, sand' : 'e.g. Diesel'} />}</Field>
        <Field label="Supplier">
          {(p) => (
            <>
              <input {...p} className="input" list="supplier-list" value={f.supplier} onChange={(e) => set('supplier', e.target.value)} placeholder="e.g. Builders" />
              <datalist id="supplier-list">
                {(suppliers.data ?? []).map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </>
          )}
        </Field>
      </div>
      {settings.vatRegistered && (
        <Field label="VAT you can claim" hint={<label className="check xs"><input type="checkbox" checked={vatAuto} onChange={(e) => setVatAuto(e.target.checked)} />Work it out ({settings.vatRateBp / 100}% included)</label>}>
          {(p) => <MoneyInput {...p} value={f.vatCents} onChange={(c) => (setVatAuto(false), set('vatCents', c ?? 0))} />}
        </Field>
      )}
      <div className="field">
        <span className="label">Slip</span>
        <div className="row wrap">
          <label className="btn">
            <Icon name="camera" size={18} />
            {f.receiptId ? 'Replace photo' : 'Photo of the slip'}
            <input type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(e) => void photo(e.target.files?.[0])} />
          </label>
          {uploading && <span className="small muted">Uploading…</span>}
          {f.receiptId && !uploading && (
            <a className="btn quiet small" href={apiUrl(`/api/attachments/${f.receiptId}`)} target="_blank" rel="noreferrer">
              View slip
            </a>
          )}
        </div>
      </div>
      <Field label="Note (optional)">{(p) => <input {...p} className="input" value={f.note} onChange={(e) => set('note', e.target.value)} />}</Field>
      {f.id && isOwner && initial?.amountCents != null && (
        <SplitCost id={f.id} totalCents={initial.amountCents} sourceId={initial.sourceId} sources={sources} onSplit={() => onSaved?.()} />
      )}
      {f.id && isOwner && <Twins id={f.id} onMerged={(gone) => (gone ? onDeleted?.() : onSaved?.())} />}
      {error && <div className="banner alert small">{error}</div>}
      <div className="row">
        <button className="btn primary big grow" disabled={busy || uploading}>
          {busy ? 'Saving…' : f.id ? 'Save cost' : 'Add cost'}
        </button>
        {f.id && isOwner && (
          <button type="button" className="btn danger" onClick={() => void del()}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

interface Twin {
  id: string;
  date: string;
  amountCents: number;
  description: string;
  supplier: string;
  categoryName: string;
  sourceName: string | null;
  projectName: string | null;
  projectNumber: number | null;
  fromStatement: boolean;
  bankMatched: boolean;
}

/** The same purchase captured twice: fold one into the other. */
function Twins({ id, onMerged }: { id: string; onMerged: (thisOneGone: boolean) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { data } = useApi<Twin[]>(open ? `/api/costs/${id}/twins` : null);
  const merge = async (copyId: string, originalId: string) => {
    try {
      const r = await api<{ merged: number; results: { ok: boolean; reason?: string }[] }>('/api/costs/merge', {
        body: { pairs: [{ removeId: copyId, keepId: originalId }], byHand: true },
      });
      if (!r.merged) return toast(r.results[0]?.reason ?? 'Couldn’t merge', 'error');
      toast('Merged. Costs → Costs counted twice → Recent merges can undo it.');
      onMerged(copyId === id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t merge', 'error');
    }
  };
  if (!open)
    return (
      <button type="button" className="btn quiet small" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        Counted twice? Find the other one
      </button>
    );
  return (
    <div className="panel panel-pad stack" style={{ gap: 8 }}>
      <strong className="small">Costs of about the same amount, within two weeks</strong>
      {!data ? (
        <span className="small muted">Looking…</span>
      ) : !data.length ? (
        <span className="small muted">None found.</span>
      ) : (
        data.map((t) => (
          <div key={t.id} className="row wrap small" style={{ gap: 8 }}>
            <span className="grow">
              {formatDate(t.date)} · {t.description}
              {t.supplier && t.supplier !== t.description ? ` – ${t.supplier}` : ''} · {formatZar(t.amountCents)}
              <span className="xs muted" style={{ display: 'block' }}>
                {t.categoryName} · {t.sourceName ?? 'not captured'} · {t.projectName ? `#${t.projectNumber} ${t.projectName}` : 'no job'}
                {t.fromStatement ? ' · added from a statement' : ''}
                {t.bankMatched ? ' · matched to the bank' : ''}
              </span>
            </span>
            <button type="button" className="btn small" onClick={() => void merge(id, t.id)} title="Remove this cost; keep the other">
              Keep that one
            </button>
            <button type="button" className="btn small quiet" onClick={() => void merge(t.id, id)} title="Remove the other; keep this cost">
              Keep this one
            </button>
          </div>
        ))
      )}
    </div>
  );
}

/** One purchase paid more than one way (part cash, part EFT): split it, one cost per payment. */
function SplitCost({ id, totalCents, sourceId, sources, onSplit }: { id: string; totalCents: number; sourceId: string | null; sources: { id: string; name: string }[]; onSplit: () => void }) {
  const toast = useToast();
  const half = Math.round(totalCents / 2);
  const [parts, setParts] = useState<{ amountCents: number | null; sourceId: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (!parts)
    return (
      <button
        type="button"
        className="btn quiet small"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => setParts([{ amountCents: half, sourceId: sourceId ?? '' }, { amountCents: totalCents - half, sourceId: '' }])}
      >
        Paid more than one way? Split it
      </button>
    );
  const sum = parts.reduce((t, p) => t + (p.amountCents ?? 0), 0);
  const left = totalCents - sum;
  const set = (i: number, change: Partial<{ amountCents: number | null; sourceId: string }>) => setParts((ps) => ps!.map((p, j) => (j === i ? { ...p, ...change } : p)));
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ ids: string[] }>(`/api/costs/${id}/split`, {
        body: { parts: parts.map((p) => ({ amountCents: p.amountCents ?? 0, sourceId: p.sourceId || null })) },
      });
      toast(`Split into ${r.ids.length} costs`);
      onSplit();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t split it', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel panel-pad stack" style={{ gap: 8 }}>
      <strong className="small">Split {formatZar(totalCents)} into one cost per payment</strong>
      <span className="xs muted">Each part keeps the job, type, supplier and slip, and says where that part was paid from.</span>
      {parts.map((p, i) => (
        <div key={i} className="row wrap" style={{ gap: 6 }}>
          <div style={{ width: 140 }}>
            <MoneyInput value={p.amountCents} onChange={(c) => set(i, { amountCents: c })} />
          </div>
          <select className="select auto" value={p.sourceId} onChange={(e) => set(i, { sourceId: e.target.value })} aria-label="Paid from">
            <option value="">Not sure yet</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {parts.length > 2 && (
            <button type="button" className="btn quiet small" onClick={() => setParts((ps) => ps!.filter((_, j) => j !== i))}>
              Remove
            </button>
          )}
        </div>
      ))}
      <div className="row wrap small" style={{ gap: 8 }}>
        {parts.length < 10 && (
          <button type="button" className="btn quiet small" onClick={() => setParts((ps) => [...ps!, { amountCents: left > 0 ? left : null, sourceId: '' }])}>
            Add a part
          </button>
        )}
        <span className={`grow ${left ? 'warn-text' : 'muted'}`}>{left ? `${formatZar(Math.abs(left))} ${left > 0 ? 'still to place' : 'too much'}` : 'Adds up'}</span>
        <button type="button" className="btn quiet small" onClick={() => setParts(null)}>
          Cancel
        </button>
        <button type="button" className="btn small primary" disabled={busy || left !== 0 || parts.some((p) => !p.amountCents)} onClick={() => void save()}>
          {busy ? 'Splitting…' : 'Split'}
        </button>
      </div>
    </div>
  );
}
