import { useMemo, useState } from 'react';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { ProjectRow, WorkerRow } from '../lib/types';

type MiniProject = Pick<ProjectRow, 'id' | 'number' | 'name' | 'status' | 'clientName'>;

/** Open jobs first; "all jobs" on request. Native select, so it's quick on a phone. */
export function ProjectSelect({
  value,
  onChange,
  id,
  emptyLabel = 'No job',
  allowEmpty = true,
  ...rest
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  id?: string;
  emptyLabel?: string;
  allowEmpty?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const { seesMoney } = useAuthed();
  const [all, setAll] = useState(false);
  const open = useApi<MiniProject[]>('/api/projects?status=open');
  // A finished job isn't in the open list: load all jobs so its name shows.
  const valueMissing = Boolean(value && open.data && !open.data.some((r) => r.id === value));
  const every = useApi<MiniProject[]>(seesMoney && (all || valueMissing) ? '/api/projects' : null);
  const list = useMemo(() => {
    const rows = (all ? every.data : open.data) ?? [];
    // Keep the current choice visible even if the job is closed.
    if (value && !rows.some((r) => r.id === value)) {
      const cur = (every.data ?? []).find((r) => r.id === value);
      if (cur) return [cur, ...rows];
    }
    return rows;
  }, [all, every.data, open.data, value]);
  const missing = value && !list.some((r) => r.id === value);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <select id={id} className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} {...rest}>
        {allowEmpty && <option value="">{emptyLabel}</option>}
        {missing && <option value={value}>{every.loading ? 'Loading…' : 'Current job'}</option>}
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            #{p.number} {p.name}
            {p.clientName && p.clientName !== p.name ? ` · ${p.clientName}` : ''}
          </option>
        ))}
      </select>
      {seesMoney && (
        <label className="check xs">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Show finished jobs too
        </label>
      )}
    </div>
  );
}

export function useWorkers() {
  return useApi<WorkerRow[]>('/api/workers');
}
