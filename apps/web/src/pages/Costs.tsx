import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { addMonths, ASSET_CATEGORIES, ASSET_CATEGORY_LABELS, financialYear, formatDate, formatZar, monthEnd, monthStart, todayIso, type AssetCategory } from '@shap/shared';
import { CostForm, costDraftFrom } from '../components/CostForm';
import { ProjectSelect } from '../components/Pickers';
import { PageHead } from '../components/Shell';
import { Drawer, Empty, ErrorBox, Field, Icon, Loading, Money, useToast } from '../components/ui';
import { api, ApiError, apiUrl } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { CostRow } from '../lib/types';

type Period = 'month' | 'last' | 'fy' | 'lastfy' | 'all';

export default function CostsPage() {
  const { ref, settings, isOwner } = useAuthed();
  const [params, setParams] = useSearchParams();
  const period = (params.get('period') as Period) || (params.get('kind') || params.get('source') === 'none' ? 'all' : 'month');
  const category = params.get('category') ?? '';
  const source = params.get('source') ?? '';
  const project = params.get('project');
  const kind = params.get('kind') ?? '';
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState<null | 'new' | CostRow>(null);
  const capturing = source === 'none' && isOwner;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [assignTo, setAssignTo] = useState('');
  const toast = useToast();
  const today = todayIso();
  const fy = financialYear(today, settings.fyEndMonth);
  const lastFy = financialYear(addMonths(fy.start, -1), settings.fyEndMonth);
  const range: Record<Period, [string | null, string | null]> = {
    month: [monthStart(today), monthEnd(today)],
    last: [monthStart(addMonths(today, -1)), monthEnd(addMonths(today, -1))],
    fy: [fy.start, fy.end],
    lastfy: [lastFy.start, lastFy.end],
    all: [null, null],
  };
  const [from, to] = range[period];
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (category) qs.set('category', category);
  if (source) qs.set('source', source);
  if (project) qs.set('project', project);
  if (kind) qs.set('kind', kind);
  const { data, error, loading, reload } = useApi<CostRow[]>(`/api/costs?${qs}`);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (data ?? []).filter((c) => !s || c.description.toLowerCase().includes(s) || c.supplier.toLowerCase().includes(s) || (c.projectName ?? '').toLowerCase().includes(s));
  }, [data, search]);
  const total = rows.reduce((s, c) => s + c.amountCents, 0);
  const setParam = (k: string, v: string | null) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n, { replace: true });
  };

  return (
    <div className="stack-lg">
      <PageHead
        title="Costs"
        sub={data ? `${rows.length} costs · ${formatZar(total)}` : undefined}
        actions={
          <>
            {isOwner && (
              <Link className="btn" to="/accounts?tab=bank">
                <Icon name="upload" size={18} />
                Bank statement
              </Link>
            )}
            <a className="btn" href={apiUrl(`/api/export/costs?${qs}`)}>
              <Icon name="download" size={18} />
              CSV
            </a>
            {isOwner && (
              <button className="btn primary" onClick={() => setDrawer('new')}>
                <Icon name="plus" size={18} />
                Add cost
              </button>
            )}
          </>
        }
      />
      {source === 'none' && (
        <div className="banner signal small">
          These costs don’t say yet which account or card paid them. Until you say, they sit in <em>Costs not yet matched to a payment</em> in
          the books, so your bank and loan balances leave them out. Tick the ones paid the same way and choose where they came from.
        </div>
      )}
      {kind === 'materials-unallocated' && (
        <div className="banner signal small row">
          <span className="grow">Parts bought without a job. Open one to put it on the right job, so that job’s profit is right.</span>
          <button className="btn small" onClick={() => setParam('kind', null)}>
            Show all costs
          </button>
        </div>
      )}
      <div className="toolbar wrap">
        <select className="select auto" value={period} onChange={(e) => setParam('period', e.target.value)} aria-label="Period">
          <option value="month">This month</option>
          <option value="last">Last month</option>
          <option value="fy">This financial year ({fy.label})</option>
          <option value="lastfy">Last financial year ({lastFy.label})</option>
          <option value="all">All time</option>
        </select>
        <select className="select auto" value={category} onChange={(e) => setParam('category', e.target.value)} aria-label="Category">
          <option value="">All types</option>
          {ref.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select className="select auto" value={source} onChange={(e) => setParam('source', e.target.value)} aria-label="Paid from">
          <option value="">Paid from anywhere</option>
          <option value="none">Not captured yet</option>
          {ref.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="auto-w">
          <ProjectSelect value={project} onChange={(v) => setParam('project', v)} emptyLabel="Any job" />
        </div>
        <div className="search">
          <Icon name="search" size={18} />
          <input className="input" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search costs" />
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
                {capturing && (
                  <th style={{ width: 36 }}>
                    <input type="checkbox" aria-label="Select all" checked={picked.size > 0 && picked.size === rows.length} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                  </th>
                )}
                <th>Date</th>
                <th>What</th>
                <th className="hide-sm">Type</th>
                <th className="hide-md">Job</th>
                <th className="hide-md">Paid from</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => isOwner && setDrawer(c)}>
                  {capturing && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.description}`}
                        checked={picked.has(c.id)}
                        onChange={() =>
                          setPicked((p) => {
                            const n = new Set(p);
                            if (n.has(c.id)) n.delete(c.id);
                            else n.add(c.id);
                            return n;
                          })
                        }
                      />
                    </td>
                  )}
                  <td className="nowrap">{formatDate(c.date)}</td>
                  <td>
                    {c.description}
                    {c.receiptId && (
                      <a className="slip-link" href={apiUrl(`/api/attachments/${c.receiptId}`)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label="View slip">
                        <Icon name="camera" size={14} />
                      </a>
                    )}
                    <div className="xs muted">
                      {c.supplier}
                      <span className="show-sm">
                        {c.supplier ? ' · ' : ''}
                        {c.categoryName}
                        {c.projectName ? ` · ${c.projectName}` : ''}
                      </span>
                    </div>
                  </td>
                  <td className="hide-sm">
                    {c.categoryName}
                    {c.assetId && <span className="chip">asset</span>}
                  </td>
                  <td className="hide-md">
                    {c.projectId ? (
                      <Link to={`/jobs/${c.projectId}`} onClick={(e) => e.stopPropagation()}>
                        #{c.projectNumber} {c.projectName}
                      </Link>
                    ) : c.categoryKind === 'materials' ? (
                      <span className="chip warn">No job</span>
                    ) : (
                      ''
                    )}
                  </td>
                  <td className="hide-md">{c.sourceName ?? <span className="chip warn">Not captured</span>}</td>
                  <td className="num">
                    <Money cents={c.amountCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty title={source === 'none' ? 'Everything is captured' : 'No costs here'}>Try a longer period or clear the filters.</Empty>
        </div>
      )}
      {capturing && picked.size > 0 && (
        <section className="panel panel-pad sticky-bar row wrap">
          <span className="grow">
            <strong>{picked.size}</strong> selected · {formatZar(rows.filter((r) => picked.has(r.id)).reduce((s, r) => s + r.amountCents, 0))}
          </span>
          <select className="select auto" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Paid from">
            <option value="">Paid from…</option>
            {ref.sources.filter((x) => x.active).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            disabled={!assignTo}
            onClick={() =>
              void api<{ updated: number }>('/api/costs/assign-source', { body: { ids: [...picked], sourceId: assignTo } })
                .then((r) => {
                  toast(`${r.updated} cost${r.updated === 1 ? '' : 's'} captured`);
                  setPicked(new Set());
                  void reload();
                })
                .catch((err) => toast(err instanceof ApiError ? err.message : 'Couldn’t save', 'error'))
            }
          >
            Capture
          </button>
        </section>
      )}
      {drawer && (
        <Drawer title={drawer === 'new' ? 'Add a cost' : 'Cost'} onClose={() => setDrawer(null)}>
          <div className="stack-lg">
            <CostForm
              initial={drawer === 'new' ? undefined : costDraftFrom(drawer)}
              onSaved={() => {
                void reload();
                if (drawer !== 'new') setDrawer(null);
              }}
              onDeleted={() => (setDrawer(null), void reload())}
            />
            {drawer !== 'new' && isOwner && <AssetFromCost cost={drawer} onDone={() => (setDrawer(null), void reload())} />}
          </div>
        </Drawer>
      )}
    </div>
  );
}

/** Something that lasts (a mixer, a generator, the bakkie) belongs on the balance sheet, not in this year's costs. */
function AssetFromCost({ cost, onDone }: { cost: CostRow; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<AssetCategory>('tools');
  const [life, setLife] = useState(36);
  if (cost.assetId)
    return (
      <div className="banner small">
        This cost is on the <Link to="/accounts?tab=assets">asset register</Link>, so it depreciates over its life instead of counting as a cost this year.
      </div>
    );
  if (!open)
    return (
      <button className="btn quiet small" onClick={() => setOpen(true)}>
        This is an asset (it lasts years)…
      </button>
    );
  const save = async () => {
    try {
      await api('/api/assets', { body: { name: cost.description, category, purchaseDate: cost.date, costCents: cost.amountCents - cost.vatCents, costId: cost.id, lifeMonths: life } });
      toast('Added to the asset register');
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t add the asset', 'error');
    }
  };
  return (
    <section className="fieldset stack">
      <strong>Put it on the asset register</strong>
      <p className="xs muted">It moves off this year’s costs and onto the balance sheet, and is written off a month at a time.</p>
      <div className="form-grid">
        <Field label="Kind">
          {(p) => (
            <select {...p} className="select" value={category} onChange={(e) => setCategory(e.target.value as AssetCategory)}>
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {ASSET_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Useful life (months)">{(p) => <input {...p} className="input" type="number" min={1} value={life} onChange={(e) => setLife(Number(e.target.value))} />}</Field>
      </div>
      <button className="btn primary" onClick={() => void save()}>
        Add to assets
      </button>
    </section>
  );
}
