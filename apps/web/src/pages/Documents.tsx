import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { formatDate, formatZar } from '@shap/shared';
import { PageHead } from '../components/Shell';
import { DocChip, Empty, ErrorBox, Icon, Loading, Money, Segmented, Tabs } from '../components/ui';
import { FileButton } from '../components/Files';
import { MonthlyList } from '../components/MonthlyInvoice';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { DocRow } from '../lib/types';

type Kind = 'invoice' | 'quote' | 'credit_note';

export default function DocumentsPage() {
  const { ref, has, can } = useAuthed();
  const isOwner = can('documents.edit');
  const brands = ref.brands.filter((b) => b.active);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = (params.get('kind') as Kind) || 'invoice';
  const state = params.get('state') ?? '';
  const onlyProforma = params.get('proforma') === '1';
  const quoteTab = has('quotes') || has('proformas');
  const status = params.get('status') ?? '';
  const [search, setSearch] = useState('');
  const qs = new URLSearchParams({ kind });
  if (state) qs.set('state', state);
  if (status) qs.set('status', status);
  const { data, error, loading, reload } = useApi<DocRow[]>(`/api/documents?${qs}`);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (data ?? []).filter((d) => (!onlyProforma || d.proforma) && (kind !== 'quote' || has('quotes') || d.proforma)).filter((d) => !s || d.number.toLowerCase().includes(s) || (d.clientName ?? '').toLowerCase().includes(s) || (d.projectName ?? '').toLowerCase().includes(s) || d.title.toLowerCase().includes(s));
  }, [data, search, onlyProforma, kind, has]);
  const owing = rows.filter((d) => d.kind === 'invoice' && d.status === 'issued').reduce((s, d) => s + d.totalCents - d.paidCents - (d.writtenOffCents ?? 0), 0);
  const filter = onlyProforma ? 'proforma' : state || status || 'all';
  const setFilter = (v: string) => {
    const n = new URLSearchParams({ kind });
    if (['owing', 'overdue', 'paid', 'written_off'].includes(v)) n.set('state', v);
    else if (v === 'proforma') n.set('proforma', '1');
    else if (v !== 'all') n.set('status', v);
    setParams(n, { replace: true });
  };

  return (
    <div className="stack-lg">
      <PageHead
        title="Quotes & invoices"
        sub={kind === 'invoice' && data ? `Still owed on these: ${formatZar(owing)}` : undefined}
        actions={
          <>
            {can('reports.view') && (
              <FileButton path="/api/export/invoices?from=2000-01-01" title="Invoices (CSV)">
                <Icon name="share" size={18} />
                CSV
              </FileButton>
            )}
            {isOwner && (
              <>
                {has('quotes') && (
                  <button className="btn" onClick={() => navigate('/documents/new?kind=quote')}>
                    New quote
                  </button>
                )}
                {has('proformas') && (
                  <button className="btn" onClick={() => navigate('/documents/new?kind=quote&proforma=1')}>
                    New pro-forma
                  </button>
                )}
                <button className="btn primary" onClick={() => navigate('/documents/new?kind=invoice')}>
                  <Icon name="plus" size={18} />
                  New invoice
                </button>
              </>
            )}
          </>
        }
      />
      {(quoteTab || has('creditNotes')) && (
        <Tabs<Kind>
          value={kind}
          onChange={(k) => setParams({ kind: k }, { replace: true })}
          tabs={[
            { value: 'invoice', label: 'Invoices' },
            ...(quoteTab ? [{ value: 'quote' as Kind, label: has('quotes') ? (has('proformas') ? 'Quotes & pro-formas' : 'Quotes') : 'Pro-formas' }] : []),
            ...(has('creditNotes') ? [{ value: 'credit_note' as Kind, label: 'Credit notes' }] : []),
          ]}
        />
      )}
      <div className="toolbar">
        {kind === 'invoice' ? (
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'owing', label: 'Owing' },
              { value: 'overdue', label: 'Overdue' },
              { value: 'paid', label: 'Paid' },
              { value: 'written_off', label: 'Delinquent' },
              { value: 'draft', label: 'Drafts' },
            ]}
          />
        ) : kind === 'quote' ? (
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'draft', label: 'Drafts' },
              { value: 'sent', label: 'Sent' },
              { value: 'accepted', label: 'Accepted' },
              ...(has('proformas') && has('quotes') ? [{ value: 'proforma', label: 'Pro-formas' }] : []),
            ]}
          />
        ) : (
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'draft', label: 'Drafts' },
              { value: 'issued', label: 'Issued' },
              { value: 'void', label: 'Void' },
            ]}
          />
        )}
        <div className="search">
          <Icon name="search" size={18} />
          <input className="input" placeholder="Number, client or job" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        </div>
      </div>
      {kind === 'invoice' && isOwner && <MonthlyList />}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : rows.length ? (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>No.</th>
                <th>Client / job</th>
                <th className="hide-sm">Date</th>
                <th className="num">Total</th>
                {kind === 'invoice' && <th className="num hide-sm">Owing</th>}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="clickable" onClick={() => navigate(`/documents/${d.id}`)}>
                  <td className="strong nowrap">
                    <Link to={`/documents/${d.id}`}>{d.number}</Link>
                    {d.proforma && <div className="xs muted">Pro-forma</div>}
                    {brands.length > 1 && d.brandId && (
                      <div className="brand-tag" style={{ '--brand-dot': brands.find((b) => b.id === d.brandId)?.accent } as CSSProperties}>
                        {d.brandName}
                      </div>
                    )}
                  </td>
                  <td>
                    {d.clientName ?? <span className="muted">No name yet</span>}
                    <div className="xs muted">
                      {d.projectName ? `#${d.projectNumber} ${d.projectName}` : d.title}
                      <span className="show-sm"> · {formatDate(d.issueDate)}</span>
                    </div>
                  </td>
                  <td className="hide-sm nowrap">{formatDate(d.issueDate)}</td>
                  <td className="num">
                    <Money cents={d.totalCents} />
                  </td>
                  {kind === 'invoice' && (
                    <td className="num hide-sm">
                      <Money cents={d.status === 'issued' && d.totalCents - d.paidCents - (d.writtenOffCents ?? 0) ? d.totalCents - d.paidCents - (d.writtenOffCents ?? 0) : null} />
                    </td>
                  )}
                  <td>
                    <DocChip status={d.status} paymentState={d.paymentState} />
                    {d.paymentState === 'overdue' && (d.reminders ?? 0) > 0 && <div className="xs muted">Reminded {d.reminders}×</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty title={`No ${kind === 'invoice' ? 'invoices' : kind === 'credit_note' ? 'credit notes' : 'quotes'} here`}>
            {kind === 'credit_note' ? 'Open an issued invoice and choose “Credit note” to take back part or all of it.' : null}
          </Empty>
        </div>
      )}
    </div>
  );
}
