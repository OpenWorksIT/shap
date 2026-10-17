import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { todayIso, vatIncluded } from '@shap/shared';
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
  sourceId: string;
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
            <select {...p} className="select" value={f.sourceId} onChange={(e) => set('sourceId', e.target.value)}>
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
