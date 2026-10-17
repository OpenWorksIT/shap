import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatDate, formatPercent } from '@shap/shared';
import { BrandSelect, useHasBrands } from '../components/Pickers';
import { PageHead } from '../components/Shell';
import { DocChip, Drawer, Empty, ErrorBox, Field, Icon, Kpi, Loading, Money, ProjectChip, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { ClientRow, DocRow, ProjectRow } from '../lib/types';

export default function ClientsPage() {
  const { isOwner } = useAuthed();
  const { data, error, loading, reload } = useApi<ClientRow[]>('/api/clients');
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState<null | 'new' | 'import'>(null);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (data ?? []).filter((c) => !s || c.name.toLowerCase().includes(s) || (c.code ?? '').toLowerCase().includes(s));
  }, [data, search]);
  const turnover = (data ?? []).reduce((s, c) => s + c.invoicedCents, 0);
  const unnamed = (data ?? []).filter((c) => c.code && c.name === c.code).length;

  return (
    <div className="stack-lg">
      <PageHead
        title="Clients"
        actions={
          isOwner && (
            <>
              <button className="btn" onClick={() => setDrawer('import')}>
                <Icon name="upload" size={18} />
                Import details
              </button>
              <button className="btn primary" onClick={() => setDrawer('new')}>
                <Icon name="plus" size={18} />
                New client
              </button>
            </>
          )
        }
      />
      {unnamed > 0 && isOwner && (
        <div className="banner small row">
          <span className="grow">
            {unnamed} client{unnamed === 1 ? ' is' : 's are'} still named by code (from the tracker). Import your client list from Invoice Ninja to fill in names, emails and addresses.
          </span>
          <button className="btn small" onClick={() => setDrawer('import')}>
            Import
          </button>
        </div>
      )}
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={18} />
          <input className="input" placeholder="Search clients" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search clients" />
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : rows.length ? (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Client</th>
                <th className="num hide-sm">Jobs</th>
                <th className="num">Invoiced</th>
                <th className="num hide-md">% of turnover</th>
                <th className="num">Gross profit</th>
                <th className="num hide-sm">GP %</th>
                <th className="num hide-md">Owing</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/clients/${c.id}`} className="strong">
                      {c.name}
                    </Link>
                    <div className="xs muted">
                      {c.code && c.code !== c.name ? c.code : ''}
                      {c.lastInvoice ? `${c.code && c.code !== c.name ? ' · ' : ''}last invoice ${formatDate(c.lastInvoice)}` : ''}
                    </div>
                  </td>
                  <td className="num hide-sm">{c.projectCount}</td>
                  <td className="num">
                    <Money cents={c.invoicedCents || null} whole />
                  </td>
                  <td className="num hide-md">{formatPercent(turnover ? c.invoicedCents / turnover : null, 1)}</td>
                  <td className="num">
                    <Money cents={c.invoicedCents ? c.grossProfitCents : null} whole />
                  </td>
                  <td className="num hide-sm">{formatPercent(c.invoicedCents ? c.grossProfitCents / c.invoicedCents : null)}</td>
                  <td className="num hide-md">
                    <Money cents={c.outstandingCents || null} whole />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty title="No clients yet" />
        </div>
      )}
      {drawer === 'new' && <ClientDrawer onClose={() => setDrawer(null)} onSaved={reload} />}
      {drawer === 'import' && <ImportClients onClose={() => setDrawer(null)} onDone={reload} />}
    </div>
  );
}

export function ClientPage() {
  const { id } = useParams<{ id: string }>();
  const { isOwner } = useAuthed();
  const { data, error, loading, reload } = useApi<{ client: ClientRow; stats: ClientRow; projects: ProjectRow[]; documents: DocRow[] }>(`/api/clients/${id}`);
  const [editing, setEditing] = useState(false);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? { message: 'Not found' }} onRetry={reload} />;
  const { client: c, stats: s } = data;
  const gp = s.invoicedCents - s.labourCostCents - s.otherCostCents;
  return (
    <div className="stack-lg">
      <PageHead
        back={{ to: '/clients', label: 'Clients' }}
        title={c.name}
        sub={[c.code !== c.name ? c.code : '', c.contactPerson, c.phone, c.email].filter(Boolean).join(' · ')}
        actions={
          isOwner && (
            <button className="btn" onClick={() => setEditing(true)}>
              <Icon name="edit" size={18} />
              Edit
            </button>
          )
        }
      />
      <div className="kpis">
        <Kpi label="Invoiced (all time)" value={<Money cents={s.invoicedCents} whole />} sub={`${s.projectCount} jobs`} />
        <Kpi label="Gross profit" value={<Money cents={gp} whole />} sub={`${formatPercent(s.invoicedCents ? gp / s.invoicedCents : null)} of invoiced`} />
        <Kpi label="Owing" value={<Money cents={s.outstandingCents} />} tone={s.outstandingCents > 0 ? 'warn' : undefined} />
      </div>
      <div className="two-col">
        <section className="panel">
          <div className="panel-head strong">Jobs</div>
          <ul className="list">
            {data.projects.map((p) => (
              <li key={p.id}>
                <Link to={`/jobs/${p.id}`} className="list-row">
                  <span className="job-no">#{p.number}</span>
                  <span className="grow">{p.name}</span>
                  <ProjectChip status={p.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head strong">Quotes & invoices</div>
          <ul className="list">
            {data.documents.map((d) => (
              <li key={d.id}>
                <Link to={`/documents/${d.id}`} className="list-row">
                  <span className="grow">
                    {d.kind === 'quote' ? 'Quote' : 'Invoice'} {d.number}
                    <div className="xs muted">{formatDate(d.issueDate)}</div>
                  </span>
                  <DocChip status={d.status} paymentState={d.kind === 'invoice' && d.status === 'issued' ? (d.paidCents >= d.totalCents ? 'paid' : d.paidCents ? 'part_paid' : 'unpaid') : null} />
                  <Money cents={d.totalCents} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {c.address && (
        <section className="panel panel-pad">
          <div className="label">Address</div>
          <p style={{ whiteSpace: 'pre-line' }}>{c.address}</p>
        </section>
      )}
      {editing && <ClientDrawer client={c} onClose={() => setEditing(false)} onSaved={reload} />}
    </div>
  );
}

function ClientDrawer({ client, onClose, onSaved }: { client?: ClientRow; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    code: client?.code ?? '',
    name: client?.name ?? '',
    contactPerson: client?.contactPerson ?? '',
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    address: client?.address ?? '',
    vatNumber: client?.vatNumber ?? '',
    notes: client?.notes ?? '',
    active: client?.active ?? true,
    brandId: client?.brandId ?? null,
  });
  const hasBrands = useHasBrands();
  const [error, setError] = useState('');
  const set = (k: keyof typeof f, v: string | boolean | null) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (client) await api(`/api/clients/${client.id}`, { method: 'PUT', body: f });
      else await api('/api/clients', { body: f });
      toast('Client saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title={client ? client.name : 'New client'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Name">{(p) => <input {...p} className="input" value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus />}</Field>
          <Field label="Code" hint="Your account code, e.g. Smith001">{(p) => <input {...p} className="input" value={f.code} onChange={(e) => set('code', e.target.value)} />}</Field>
        </div>
        <div className="form-grid">
          <Field label="Contact person">{(p) => <input {...p} className="input" value={f.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} />}</Field>
          <Field label="Phone">{(p) => <input {...p} className="input" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />}</Field>
        </div>
        <Field label="Email (invoices go here)">{(p) => <input {...p} className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}</Field>
        <Field label="Address">{(p) => <textarea {...p} className="textarea" rows={3} value={f.address} onChange={(e) => set('address', e.target.value)} />}</Field>
        <Field label="VAT number">{(p) => <input {...p} className="input" value={f.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} />}</Field>
        {hasBrands && (
          <Field label="Usually trading as" hint="New jobs and documents for this client use it unless the job says otherwise">
            {(p) => <BrandSelect {...p} value={f.brandId} onChange={(v) => set('brandId', v)} emptyLabel="The default" />}
          </Field>
        )}
        <Field label="Notes">{(p) => <textarea {...p} className="textarea" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
      </form>
    </Drawer>
  );
}

interface CsvRow {
  index: number;
  name: string;
  contact: string;
  email: string;
  phone: string;
  address: string;
  vatNumber: string;
  ref: string;
  suggestion: { clientId: string; reason: string; score: number } | null;
}
interface CsvPreview {
  rows: CsvRow[];
  clients: { id: string; code: string | null; name: string; projects: string[] }[];
  jobsWithoutClient: { id: string; name: string; suggestedRow: number | null }[];
}

/**
 * Two steps: read the CSV and suggest which client each row is (tracker clients are named by
 * code, so the clues are the code, the job names and the street address), then let the owner
 * confirm or change each one before anything is written.
 */
function ImportClients({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [matches, setMatches] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<Record<string, string>>({});

  const read = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const text = await file.text();
      const r = await api<CsvPreview>('/api/clients/import-csv/preview', { body: { csv: text } });
      setCsv(text);
      setPreview(r);
      setMatches(Object.fromEntries(r.rows.map((x) => [String(x.index), x.suggestion?.clientId ?? 'new'])));
      setJobs(Object.fromEntries(r.jobsWithoutClient.filter((j) => j.suggestedRow != null).map((j) => [j.id, String(j.suggestedRow)])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t read that file');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      const jobMap = Object.fromEntries(Object.entries(jobs).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
      const r = await api<{ updated: number; added: number; linked: number }>('/api/clients/import-csv', { body: { csv, matches, jobs: jobMap } });
      toast(`${r.updated} updated, ${r.added} added${r.linked ? `, ${r.linked} jobs linked` : ''}`);
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t import');
    } finally {
      setBusy(false);
    }
  };
  // A client can only be matched once.
  const usedBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const [row, id] of Object.entries(matches)) if (id !== 'new' && id !== 'skip') m.set(id, row);
    return m;
  }, [matches]);

  if (!preview)
    return (
      <Drawer title="Import client details" onClose={onClose}>
        <div className="stack">
          <p className="small">
            In Invoice Ninja, open <strong>Clients</strong>, choose <strong>Export</strong> and save the CSV. Shap suggests which of your clients each row is
            (from the code, the job names and the street address), and you check the list before anything changes. Any CSV with a “Name” column works.
          </p>
          <label className="btn primary big block">
            <Icon name="upload" size={18} />
            {busy ? 'Reading…' : 'Choose the CSV file'}
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void read(e.target.files?.[0])} disabled={busy} />
          </label>
          {error && <div className="banner alert small">{error}</div>}
        </div>
      </Drawer>
    );

  const counts = Object.values(matches).reduce(
    (a, v) => (v === 'new' ? { ...a, added: a.added + 1 } : v === 'skip' ? a : { ...a, updated: a.updated + 1 }),
    { updated: 0, added: 0 },
  );
  const rowLabel = (i: number) => preview.rows.find((r) => r.index === i)?.name ?? `Row ${i + 1}`;
  return (
    <Drawer title="Check the matches" onClose={onClose} wide>
      <div className="stack">
        <p className="small">
          Each row from the file, and the client Shap thinks it is. Change any that are wrong. A matched client takes the file’s name, contact, email, phone,
          address and VAT number; its code and jobs stay.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>In the file</th>
                <th>Is client</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r) => {
                const v = matches[String(r.index)] ?? 'new';
                return (
                  <tr key={r.index}>
                    <td>
                      <strong>{r.name}</strong>
                      <div className="xs muted">{[r.contact, r.email, r.phone].filter(Boolean).join(' · ')}</div>
                      {r.address && <div className="xs muted ellipsis">{r.address.replace(/\n/g, ', ')}</div>}
                    </td>
                    <td style={{ minWidth: 200 }}>
                      <select className="select" value={v} onChange={(e) => setMatches((m) => ({ ...m, [String(r.index)]: e.target.value }))} aria-label={`Client for ${r.name}`}>
                        <option value="new">Add as a new client</option>
                        <option value="skip">Skip this row</option>
                        {preview.clients.map((c) => (
                          <option key={c.id} value={c.id} disabled={usedBy.has(c.id) && usedBy.get(c.id) !== String(r.index)}>
                            {c.code && c.code !== c.name ? `${c.code} · ` : ''}
                            {c.name}
                            {c.projects.length ? ` (${c.projects.slice(0, 2).join(', ')})` : ''}
                          </option>
                        ))}
                      </select>
                      {r.suggestion && v === r.suggestion.clientId && <div className="xs muted">Suggested: {r.suggestion.reason}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {preview.jobsWithoutClient.length > 0 && (
          <section className="fieldset stack">
            <strong>Jobs with no client yet</strong>
            <p className="xs muted">Link them to a row from the file, so their invoices carry the client’s details.</p>
            {preview.jobsWithoutClient.map((j) => (
              <label key={j.id} className="row wrap">
                <span className="grow small">{j.name}</span>
                <select className="select auto" value={jobs[j.id] ?? ''} onChange={(e) => setJobs((x) => ({ ...x, [j.id]: e.target.value }))}>
                  <option value="">Leave without a client</option>
                  {preview.rows
                    .filter((r) => matches[String(r.index)] !== 'skip')
                    .map((r) => (
                      <option key={r.index} value={String(r.index)}>
                        {rowLabel(r.index)}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </section>
        )}
        {error && <div className="banner alert small">{error}</div>}
        <div className="row wrap">
          <button className="btn primary big grow" onClick={() => void apply()} disabled={busy}>
            {busy ? 'Saving…' : `Update ${counts.updated}, add ${counts.added}`}
          </button>
          <button className="btn quiet" onClick={() => setPreview(null)}>
            Choose another file
          </button>
        </div>
      </div>
    </Drawer>
  );
}
