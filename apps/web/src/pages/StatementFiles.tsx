import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { addMonths, formatDate, monthLabel, todayIso } from '@shap/shared';
import { Empty, ErrorBox, Field, Icon, Loading, useToast } from '../components/ui';
import { api, ApiError, apiUrl } from '../lib/api';
import { fileToBase64 } from '../lib/files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';

interface Files {
  files: { id: string; sourceId: string; sourceName: string; month: string; filename: string; attachmentId: string; createdAt: string }[];
  missing: { sourceId: string; sourceName: string; months: string[] }[];
}

/**
 * The bank's own monthly statements (PDFs) on file: for your records and for the accountant,
 * who can download them from here. Which accounts need them is set under Settings → Lists.
 */
export function StatementFiles() {
  const { ref, isOwner } = useAuthed();
  const toast = useToast();
  const [params] = useSearchParams();
  const { data, error, reload } = useApi<Files>('/api/statement-files');
  const sources = ref.sources.filter((s) => s.active && s.kind !== 'cash');
  const [sourceId, setSourceId] = useState(params.get('source') ?? sources.find((s) => s.statementsRequired)?.id ?? sources[0]?.id ?? '');
  const [month, setMonth] = useState(params.get('month') ?? addMonths(todayIso(), -1).slice(0, 7));
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return toast('Choose the statement as a PDF', 'error');
    setBusy(true);
    try {
      await api('/api/statement-files', { body: { sourceId, month, filename: file.name, mime: 'application/pdf', dataBase64: await fileToBase64(file) } });
      toast(`${monthLabel(month)} statement saved`);
      // Next missing month for this account, if any, so a run of uploads is quick.
      const next = data?.missing.find((m) => m.sourceId === sourceId)?.months.find((m) => m !== month);
      if (next) setMonth(next);
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t upload it', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const shown = data.files.filter((f) => !filter || f.sourceId === filter);
  return (
    <div className="stack-lg">
      {data.missing.length > 0 && (
        <section className="panel panel-pad stack">
          <h3>Still to upload</h3>
          {data.missing.map((m) => (
            <div key={m.sourceId} className="row wrap" style={{ gap: 6 }}>
              <strong className="small">{m.sourceName}:</strong>
              {m.months.map((mm) => (
                <button key={mm} className={`chip ${sourceId === m.sourceId && month === mm ? 'ok' : 'warn'}`} onClick={() => (setSourceId(m.sourceId), setMonth(mm))} disabled={!isOwner}>
                  {monthLabel(mm)}
                </button>
              ))}
            </div>
          ))}
        </section>
      )}
      {isOwner && (
        <section className="panel panel-pad stack">
          <h3>Upload a statement</h3>
          <div className="form-grid">
            <Field label="Account">
              {(p) => (
                <select {...p} className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Month">{(p) => <input {...p} className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}</Field>
          </div>
          <label className="btn primary">
            <Icon name="upload" size={18} />
            {busy ? 'Uploading…' : `Choose the ${month ? monthLabel(month) : ''} PDF`}
            <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => (void upload(e.target.files?.[0]), (e.target.value = ''))} disabled={busy || !sourceId || !month} />
          </label>
          <p className="xs muted">Which accounts need a statement every month is set under Settings → Lists → Paid from / into.</p>
        </section>
      )}
      <section className="panel">
        <div className="panel-head spread">
          <strong>On file</strong>
          <select className="select auto" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Account">
            <option value="">All accounts</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {shown.length ? (
          <ul className="list">
            {shown.map((f) => (
              <li key={f.id} className="list-row">
                <Icon name="docs" size={18} />
                <span className="grow small">
                  <strong>{monthLabel(f.month)}</strong> · {f.sourceName}
                  <div className="xs muted">
                    {f.filename} · uploaded {formatDate(f.createdAt.slice(0, 10))}
                  </div>
                </span>
                <a className="btn quiet small" href={apiUrl(`/api/attachments/${f.attachmentId}`)} target="_blank" rel="noreferrer">
                  <Icon name="download" size={14} />
                  Open
                </a>
                {isOwner && (
                  <button
                    className="btn quiet small"
                    aria-label="Delete"
                    onClick={() => {
                      if (confirm(`Delete the ${monthLabel(f.month)} statement for ${f.sourceName}?`))
                        void api(`/api/statement-files/${f.id}`, { method: 'DELETE' }).then(() => (toast('Deleted'), reload()));
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No statements on file">Upload the bank’s PDF statement for each month.</Empty>
        )}
      </section>
    </div>
  );
}
