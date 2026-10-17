import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatDate, formatPercent, formatZar, lineTotal } from '@shap/shared';
import { CostForm, costDraftFrom } from '../components/CostForm';
import { LabourEntryForm, LabourForm } from '../components/LabourForm';
import { ProjectDrawer } from '../components/ProjectForm';
import { PageHead } from '../components/Shell';
import { DocChip, Drawer, Empty, ErrorBox, Field, Icon, Loading, Money, MoneyInput, ProjectChip, Tabs, useToast } from '../components/ui';
import { api, ApiError, apiUrl } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { CostRow, DocRow, LabourEntry, PlannedItem, ProjectRow } from '../lib/types';

interface ProjectDetail {
  project: ProjectRow;
  summary?: ProjectRow;
  planned: PlannedItem[];
  labour?: LabourEntry[];
  costs?: CostRow[];
  documents?: DocRow[];
  workers?: { id: string; name: string; days: number; costCents: number }[];
}

type Tab = 'labour' | 'costs' | 'plan' | 'docs';

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { isOwner, seesMoney, user } = useAuthed();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<ProjectDetail>(`/api/projects/${id}`);
  const [tab, setTab] = useState<Tab>(seesMoney ? 'labour' : 'plan');
  const [editing, setEditing] = useState(false);
  const [drawer, setDrawer] = useState<null | { kind: 'labour' } | { kind: 'cost'; cost?: CostRow; planned?: PlannedItem } | { kind: 'entry'; entry: LabourEntry }>(null);

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? { message: 'Not found' }} onRetry={reload} />;
  const { project: p, summary: s } = data;

  const newDoc = (kind: 'quote' | 'invoice') => navigate(`/documents/new?kind=${kind}&project=${p.id}`);
  const fromPlan = async () => {
    const markup = prompt('Mark-up on parts (%)', '0');
    if (markup == null) return;
    try {
      const r = await api<{ id: string }>(`/api/projects/${p.id}/quote-from-plan`, { body: { markupBp: Math.round(Number(markup || 0) * 100) } });
      toast('Draft quote made from the plan');
      navigate(`/documents/${r.id}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t make the quote', 'error');
    }
  };

  return (
    <div className="stack-lg">
      <PageHead
        back={{ to: '/jobs', label: 'Jobs' }}
        title={
          <>
            <span className="job-no">#{p.number}</span> {p.name}
          </>
        }
        sub={
          <span className="row wrap" style={{ gap: 8 }}>
            <ProjectChip status={p.status} />
            {p.clientName && (seesMoney ? <Link to={`/clients/${p.clientId}`}>{p.clientName}</Link> : <span>{p.clientName}</span>)}
            {p.siteAddress && <span className="muted">· {p.siteAddress}</span>}
            {p.startDate && <span className="muted">· started {formatDate(p.startDate)}</span>}
          </span>
        }
        actions={
          <>
            {user.role !== 'accountant' && (
              <>
                <button className="btn" onClick={() => setDrawer({ kind: 'labour' })}>
                  <Icon name="workers" size={18} />
                  Log day
                </button>
                <button className="btn" onClick={() => setDrawer({ kind: 'cost' })}>
                  <Icon name="costs" size={18} />
                  Add cost
                </button>
              </>
            )}
            {isOwner && (
              <>
                <button className="btn" onClick={() => newDoc('quote')}>
                  Quote
                </button>
                <button className="btn primary" onClick={() => newDoc('invoice')}>
                  Invoice
                </button>
                <button className="btn quiet" onClick={() => setEditing(true)} aria-label="Edit job">
                  <Icon name="edit" size={18} />
                </button>
              </>
            )}
          </>
        }
      />

      {s && <Breakdown s={s} />}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          ...(seesMoney
            ? [
                { value: 'labour' as Tab, label: 'Labour', count: data.labour?.length },
                { value: 'costs' as Tab, label: 'Costs', count: data.costs?.length },
              ]
            : []),
          { value: 'plan', label: 'Parts plan', count: data.planned.length },
          ...(seesMoney ? [{ value: 'docs' as Tab, label: 'Quotes & invoices', count: data.documents?.length }] : []),
        ]}
      />

      {tab === 'labour' && data.labour && (
        <div className="two-col wide-left">
          <section className="panel table-wrap">
            {data.labour.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Worker</th>
                    <th className="num">Days</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.labour.map((e) => (
                    <tr key={e.id} className={isOwner ? 'clickable' : ''} onClick={() => isOwner && setDrawer({ kind: 'entry', entry: e })}>
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
            ) : (
              <Empty title="No labour logged on this job yet" />
            )}
          </section>
          <section className="panel">
            <div className="panel-head strong">By worker</div>
            <ul className="list">
              {(data.workers ?? []).map((w) => (
                <li key={w.id} className="list-row">
                  <Link to={`/workers/${w.id}`} className="grow">
                    {w.name}
                  </Link>
                  <span className="small muted">{w.days} days</span>
                  <Money cents={w.costCents} whole />
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {tab === 'costs' && data.costs && (
        <section className="panel table-wrap">
          {data.costs.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th className="hide-sm">Type</th>
                  <th className="hide-sm">Paid from</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.costs.map((c) => (
                  <tr key={c.id} className={isOwner ? 'clickable' : ''} onClick={() => isOwner && setDrawer({ kind: 'cost', cost: c })}>
                    <td className="nowrap">{formatDate(c.date)}</td>
                    <td>
                      {c.description}
                      {c.supplier && <span className="muted"> · {c.supplier}</span>}
                      {c.receiptId && (
                        <a className="slip-link" href={apiUrl(`/api/attachments/${c.receiptId}`)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label="View slip">
                          <Icon name="camera" size={14} />
                        </a>
                      )}
                    </td>
                    <td className="hide-sm">{c.categoryName}</td>
                    <td className="hide-sm">{c.sourceName ?? <span className="chip warn">Not captured</span>}</td>
                    <td className="num">
                      <Money cents={c.amountCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No costs on this job yet" />
          )}
        </section>
      )}

      {tab === 'plan' && (
        <PartsPlan projectId={p.id} items={data.planned} canEdit={isOwner} onChange={reload} onBuy={(item) => setDrawer({ kind: 'cost', planned: item })} onQuote={() => void fromPlan()} />
      )}

      {tab === 'docs' && data.documents && (
        <section className="panel">
          {data.documents.length ? (
            <ul className="list">
              {data.documents.map((d) => (
                <li key={d.id}>
                  <Link to={`/documents/${d.id}`} className="list-row">
                    <span className="grow">
                      <strong>
                        {d.kind === 'quote' ? 'Quote' : 'Invoice'} {d.number}
                      </strong>
                      <div className="xs muted">
                        {formatDate(d.issueDate)}
                        {d.title ? ` · ${d.title}` : ''}
                      </div>
                    </span>
                    <DocChip status={d.status} paymentState={d.paymentState ?? (d.kind === 'invoice' && d.status === 'issued' ? (d.paidCents >= d.totalCents ? 'paid' : d.paidCents > 0 ? 'part_paid' : 'unpaid') : null)} />
                    <Money cents={d.totalCents} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No quotes or invoices yet" />
          )}
        </section>
      )}

      {p.notes && (
        <section className="panel panel-pad">
          <div className="label">Notes</div>
          <p style={{ whiteSpace: 'pre-line' }}>{p.notes}</p>
        </section>
      )}

      {editing && <ProjectDrawer project={p} onClose={() => setEditing(false)} onSaved={reload} />}
      {drawer?.kind === 'labour' && (
        <Drawer title="Log a day on this job" sub={p.name} onClose={() => setDrawer(null)}>
          <LabourForm projectId={p.id} onSaved={() => (setDrawer(null), void reload())} />
        </Drawer>
      )}
      {drawer?.kind === 'entry' && (
        <Drawer title="Labour entry" onClose={() => setDrawer(null)}>
          <LabourEntryForm entry={drawer.entry} onSaved={() => (setDrawer(null), void reload())} onDeleted={() => (setDrawer(null), void reload())} />
        </Drawer>
      )}
      {drawer?.kind === 'cost' && (
        <Drawer title={drawer.cost ? 'Cost' : drawer.planned ? 'Bought a planned part' : 'Add a cost to this job'} sub={p.name} onClose={() => setDrawer(null)}>
          <CostForm
            initial={drawer.cost ? costDraftFrom(drawer.cost) : undefined}
            projectId={p.id}
            plannedItem={drawer.planned}
            onSaved={() => (setDrawer(null), void reload())}
            onDeleted={() => (setDrawer(null), void reload())}
          />
        </Drawer>
      )}
    </div>
  );
}

/** Quoted / spent / invoiced, split into labour, materials and demo, as on the tracker's Per Project sheet. */
function Breakdown({ s }: { s: ProjectRow }) {
  const rows: [string, number, number, number][] = [
    ['Labour', s.quotedLabourCents, s.actualLabourCents, s.invoicedLabourCents],
    ['Materials', s.quotedMaterialsCents, s.actualMaterialsCents, s.invoicedMaterialsCents],
    ['Demo', s.quotedDemoCents, s.actualDemoCents, s.invoicedDemoCents],
  ];
  if (s.quotedOtherCents || s.actualOtherCents || s.invoicedOtherCents) rows.push(['Other', s.quotedOtherCents, s.actualOtherCents, s.invoicedOtherCents]);
  return (
    <div className="breakdown">
      <section className="panel table-wrap">
        <table className="table money-table">
          <thead>
            <tr>
              <th />
              <th className="num">Quoted{s.quotedFromQuote ? '' : ' (estimate)'}</th>
              <th className="num">Spent</th>
              <th className="num">Invoiced</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, q, a, i]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="num">
                  <Money cents={q || null} />
                </td>
                <td className={`num ${q && a > q ? 'warn-text' : ''}`}>
                  <Money cents={a || null} />
                </td>
                <td className="num">
                  <Money cents={i || null} />
                </td>
              </tr>
            ))}
            <tr className="total">
              <th scope="row">Total</th>
              <td className="num">
                <Money cents={s.quotedCents} />
              </td>
              <td className="num">
                <Money cents={s.actualCents} />
              </td>
              <td className="num">
                <Money cents={s.invoicedCents} />
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <div className="kpis compact">
        <div className="kpi">
          <div className="kpi-label">Gross profit</div>
          <div className="kpi-value">
            <Money cents={s.invoicedCents ? s.grossProfitCents : null} />
          </div>
          <div className="kpi-sub">{s.invoicedCents ? `${formatPercent(s.margin)} margin` : 'once invoiced'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Received</div>
          <div className="kpi-value">
            <Money cents={s.receivedCents} />
          </div>
          <div className="kpi-sub">{s.outstandingCents > 0 ? `${formatZar(s.outstandingCents)} still owed` : s.invoicedCents ? 'paid up' : '–'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Days worked</div>
          <div className="kpi-value">{s.daysWorked}</div>
          <div className="kpi-sub">{s.daysWorked ? `${formatZar(Math.round(s.actualLabourCents / s.daysWorked), { cents: false })} a day` : '–'}</div>
        </div>
      </div>
    </div>
  );
}

function PartsPlan({ projectId, items, canEdit, onChange, onBuy, onQuote }: { projectId: string; items: PlannedItem[]; canEdit: boolean; onChange: () => void; onBuy: (i: PlannedItem) => void; onQuote: () => void }) {
  const toast = useToast();
  const blank = { description: '', qty: 1, unit: '', unitCostCents: null as number | null, supplier: '', category: 'materials' as 'materials' | 'demo', note: '' };
  const [f, setF] = useState(blank);
  const [editId, setEditId] = useState<string | null>(null);
  const total = items.reduce((s, i) => s + i.totalCents, 0);
  const bought = items.filter((i) => i.costId).reduce((s, i) => s + i.boughtCents, 0);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...f, unitCostCents: f.unitCostCents ?? 0 };
      if (editId) await api(`/api/planned/${editId}`, { method: 'PUT', body });
      else await api(`/api/projects/${projectId}/planned`, { body });
      setF(blank);
      setEditId(null);
      onChange();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save', 'error');
    }
  };
  const remove = async (id: string) => {
    await api(`/api/planned/${id}`, { method: 'DELETE' });
    onChange();
  };

  return (
    <section className="panel">
      <div className="panel-head spread">
        <span>
          <strong>Parts to buy</strong>
          <span className="small muted"> · planned {formatZar(total)} · bought {formatZar(bought)}</span>
        </span>
        {canEdit && items.length > 0 && (
          <button className="btn small" onClick={onQuote}>
            Make a quote from this
          </button>
        )}
      </div>
      {items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num hide-sm">Each</th>
                <th className="num">Total</th>
                <th>Bought</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.description}
                    {(i.supplier || i.category === 'demo') && (
                      <div className="xs muted">
                        {i.supplier}
                        {i.category === 'demo' ? `${i.supplier ? ' · ' : ''}demo` : ''}
                      </div>
                    )}
                  </td>
                  <td className="num nowrap">
                    {i.qty} {i.unit}
                  </td>
                  <td className="num hide-sm">
                    <Money cents={i.unitCostCents} />
                  </td>
                  <td className="num">
                    <Money cents={i.totalCents} />
                  </td>
                  <td>
                    {i.costId ? (
                      <span className="chip d-paid">
                        <Icon name="check" size={14} />
                        {formatZar(i.boughtCents, { cents: false })}
                      </span>
                    ) : (
                      <button className="btn small" onClick={() => onBuy(i)}>
                        Bought it
                      </button>
                    )}
                  </td>
                  {canEdit && (
                    <td className="nowrap">
                      <button
                        className="btn quiet small"
                        aria-label="Edit"
                        onClick={() => (setEditId(i.id), setF({ description: i.description, qty: i.qty, unit: i.unit, unitCostCents: i.unitCostCents, supplier: i.supplier, category: i.category, note: i.note }))}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                      <button className="btn quiet small" aria-label="Remove" onClick={() => void remove(i.id)}>
                        <Icon name="trash" size={16} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No parts planned">List what the job needs and what it should cost. Tick items off as you buy them, and turn the list into a quote.</Empty>
      )}
      {canEdit && (
        <form className="panel-pad plan-form" onSubmit={save}>
          <Field label={editId ? 'Change item' : 'Add an item'} className="grow">
            {(p) => <input {...p} className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Corrugated sheets 3.6m" required />}
          </Field>
          <Field label="Qty">{(p) => <input {...p} className="input" type="number" step="any" min="0" value={f.qty} onChange={(e) => setF({ ...f, qty: Number(e.target.value) })} />}</Field>
          <Field label="Unit">{(p) => <input {...p} className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="each, m, bag" />}</Field>
          <Field label="Each">{(p) => <MoneyInput {...p} value={f.unitCostCents} onChange={(c) => setF({ ...f, unitCostCents: c })} />}</Field>
          <Field label="Supplier">{(p) => <input {...p} className="input" value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} />}</Field>
          <div className="field">
            <span className="label">&nbsp;</span>
            <div className="row">
              <button className="btn primary">{editId ? 'Save' : 'Add'}</button>
              {editId && (
                <button type="button" className="btn quiet" onClick={() => (setEditId(null), setF(blank))}>
                  Cancel
                </button>
              )}
            </div>
          </div>
          {f.unitCostCents != null && f.qty > 0 && <div className="xs muted span-all">Line total {formatZar(lineTotal(f.qty, f.unitCostCents))}</div>}
        </form>
      )}
    </section>
  );
}
