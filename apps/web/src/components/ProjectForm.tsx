import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PROJECT_STATUS_LABELS, PROJECT_STATUSES, type ProjectStatus } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import type { ClientRow, ProjectRow } from '../lib/types';
import { Drawer, Field, MoneyInput, useToast } from './ui';

export function ProjectDrawer({ project, onClose, onSaved }: { project?: ProjectRow; onClose: () => void; onSaved?: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const clients = useApi<ClientRow[]>('/api/clients');
  const [f, setF] = useState({
    name: project?.name ?? '',
    clientId: project?.clientId ?? null,
    status: (project?.status ?? 'active') as ProjectStatus,
    siteAddress: project?.siteAddress ?? '',
    startDate: project?.startDate ?? null,
    endDate: project?.endDate ?? null,
    estLabourCents: project?.estLabourCents ?? 0,
    estMaterialsCents: project?.estMaterialsCents ?? 0,
    estDemoCents: project?.estDemoCents ?? 0,
    notes: project?.notes ?? '',
  });
  const [newClient, setNewClient] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      let clientId = f.clientId;
      if (clientId === 'new') {
        if (!newClient.trim()) throw new ApiError(400, 'Type the new client’s name', 'validation');
        clientId = (await api<{ id: string }>('/api/clients', { body: { name: newClient.trim() } })).id;
      }
      const body = { ...f, clientId };
      if (project) {
        await api(`/api/projects/${project.id}`, { method: 'PUT', body });
        toast('Job saved');
        onSaved?.();
        onClose();
      } else {
        const row = await api<{ id: string; number: number }>('/api/projects', { body });
        toast(`Job #${row.number} created`);
        onClose();
        navigate(`/jobs/${row.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={project ? `Job #${project.number}` : 'New job'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Job name" hint="Client and what it is, e.g. “Smith shower”">{(p) => <input {...p} className="input" value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus />}</Field>
        <Field label="Client">
          {(p) => (
            <select {...p} className="select" value={f.clientId ?? ''} onChange={(e) => set('clientId', e.target.value || null)}>
              <option value="">No client yet</option>
              <option value="new">+ New client…</option>
              {(clients.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.code && c.code !== c.name ? ` (${c.code})` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
        {f.clientId === 'new' && <Field label="New client’s name">{(p) => <input {...p} className="input" value={newClient} onChange={(e) => setNewClient(e.target.value)} />}</Field>}
        <div className="form-grid">
          <Field label="Status">
            {(p) => (
              <select {...p} className="select" value={f.status} onChange={(e) => set('status', e.target.value as ProjectStatus)}>
                {PROJECT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {PROJECT_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Started">{(p) => <input {...p} className="input" type="date" value={f.startDate ?? ''} onChange={(e) => set('startDate', e.target.value || null)} />}</Field>
        </div>
        <Field label="Site address">{(p) => <input {...p} className="input" value={f.siteAddress} onChange={(e) => set('siteAddress', e.target.value)} />}</Field>
        <fieldset className="fieldset">
          <legend>Estimate</legend>
          <p className="xs muted">Used until you accept a quote for this job; then the quote’s figures count.</p>
          <div className="form-grid">
            <Field label="Labour">{(p) => <MoneyInput {...p} value={f.estLabourCents} onChange={(c) => set('estLabourCents', c ?? 0)} />}</Field>
            <Field label="Materials">{(p) => <MoneyInput {...p} value={f.estMaterialsCents} onChange={(c) => set('estMaterialsCents', c ?? 0)} />}</Field>
            <Field label="Demo">{(p) => <MoneyInput {...p} value={f.estDemoCents} onChange={(c) => set('estDemoCents', c ?? 0)} />}</Field>
          </div>
        </fieldset>
        <Field label="Notes">{(p) => <textarea {...p} className="textarea" value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={3} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block" disabled={busy}>
          {busy ? 'Saving…' : project ? 'Save job' : 'Create job'}
        </button>
      </form>
    </Drawer>
  );
}
