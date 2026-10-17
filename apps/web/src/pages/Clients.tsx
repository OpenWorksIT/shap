import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatDate, formatPercent } from '@shap/shared';
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
  });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
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
        <Field label="Notes">{(p) => <textarea {...p} className="textarea" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
      </form>
    </Drawer>
  );
}

function ImportClients({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ updated: number; added: number }>('/api/clients/import-csv', { body: { csv: await file.text() } });
      toast(`${r.updated} clients updated, ${r.added} added`);
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t import that file');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer title="Import client details" onClose={onClose}>
      <div className="stack">
        <p className="small">
          In Invoice Ninja, open <strong>Clients</strong>, choose <strong>Export</strong> and save the CSV. Shap matches each row on the client number (your
          codes, like <code>Smith001</code>) or the name, fills in names, emails, phones and addresses, and adds any client it doesn’t have. Any CSV with
          a “Name” column works.
        </p>
        <label className="btn primary big block">
          <Icon name="upload" size={18} />
          {busy ? 'Importing…' : 'Choose the CSV file'}
          <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void upload(e.target.files?.[0])} disabled={busy} />
        </label>
        {error && <div className="banner alert small">{error}</div>}
      </div>
    </Drawer>
  );
}
