/**
 * Inventory (docs/SALES_AND_STOCK.md): what's on the shelf at average cost, the supplier
 * invoices it came in on, what went back or never arrived (claims on the supplier), their credit
 * notes, the stock takes that correct it, and each item's whole history. Every movement is
 * recorded once, with who and why, and posts to the books by itself: nothing is changed or
 * deleted afterwards. A mistake is put right with the next movement (a return, a count).
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatZar, PURCHASE_VAT, PURCHASE_VAT_CODES, todayIso, vatRateOn, type PurchaseVatCode } from '@shap/shared';
import { PageHead } from '../components/Shell';
import { Drawer, Empty, ErrorBox, Field, Icon, Kpi, Loading, Money, MoneyInput, Segmented, Tabs, useToast } from '../components/ui';
import { api, ApiError, apiUrl } from '../lib/api';
import { compressSlip } from '../lib/files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { MOVE_LABELS, netPriceCents, qtyText, toQty, type Item, type StockMove } from '../lib/selling';
import { ItemDrawer, SaleDrawer } from './Sales';

type Tab = 'stock' | 'purchases' | 'claims' | 'takes' | 'value';

interface Purchase {
  id: string;
  date: string;
  supplier: string;
  reference: string;
  amountCents: number;
  vatCents: number;
  description: string;
  sourceName: string;
  sourceRole: string | null;
  lines: number;
}
interface Claim {
  id: string;
  supplier: string;
  kind: 'short' | 'return';
  date: string;
  qty: number;
  valueCents: number;
  settledCents: number;
  leftCents: number;
  itemId: string;
  description: string;
  settlements: { id: string; date: string; kind: string; amountCents: number; reason: string; creditReference: string | null }[];
}
interface Take {
  id: string;
  date: string;
  note: string;
  byName: string | null;
  items: number;
  corrected: number;
  valueCents: number;
  createdAt: string;
}

export default function InventoryPage() {
  const { can } = useAuthed();
  // Buying, counting, and seeing what it cost are each someone's job (Settings → People who sign in).
  const buys = can('stock.buy');
  const counts = can('stock.count');
  const costs = can('stock.costs');
  const [tab, setTab] = useState<Tab>('stock');
  const items = useApi<Item[]>('/api/items?stocked=1');
  const [open, setOpen] = useState<{ kind: 'item' | 'purchase' | 'take' | 'sale'; id: string } | null>(null);
  const [form, setForm] = useState<'purchase' | 'return' | 'credit' | 'take' | null>(null);
  const stocked = (items.data ?? []).filter((i) => i.stocked);
  const value = stocked.reduce((t, i) => t + Number(i.stockValueCents), 0);
  const low = stocked.filter((i) => i.active && Number(i.qtyOnHand) <= Number(i.reorderLevel) && Number(i.reorderLevel) > 0).length;
  const negative = stocked.filter((i) => Number(i.qtyOnHand) < 0).length;
  const done = () => {
    setForm(null);
    void items.reload();
  };
  return (
    <div className="stack-lg">
      <PageHead
        title="Inventory"
        sub={items.data && costs ? <>Stock on hand at average cost: <Money cents={value} /></> : undefined}
        actions={
          (buys || counts) && (
            <>
              {buys && (
                <button className="btn primary" onClick={() => setForm('purchase')}>
                  <Icon name="plus" size={18} />
                  Supplier invoice
                </button>
              )}
              {counts && (
                <button className="btn" onClick={() => setForm('take')}>
                  Count stock
                </button>
              )}
            </>
          )
        }
      />
      {(negative > 0 || low > 0) && (
        <div className="kpis compact">
          {negative > 0 && <Kpi label="Sold short (below nothing)" value={negative} sub="Put right when stock arrives, or at a count" tone="bad" />}
          {low > 0 && <Kpi label="Down to the reorder level" value={low} tone="warn" />}
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'stock', label: 'Stock' },
          ...(costs
            ? [
                { value: 'purchases' as Tab, label: 'Supplier invoices' },
                { value: 'claims' as Tab, label: 'Returns and claims' },
              ]
            : []),
          { value: 'takes', label: 'Stock takes' },
          ...(costs ? [{ value: 'value' as Tab, label: 'Valuation' }] : []),
        ]}
      />
      {tab === 'stock' && <StockList items={items} onOpen={(id) => setOpen({ kind: 'item', id })} />}
      {tab === 'purchases' && costs && <Purchases onOpen={(id) => setOpen({ kind: 'purchase', id })} />}
      {tab === 'claims' && costs && <Claims onReturn={() => setForm('return')} onCredit={() => setForm('credit')} onOpenItem={(id) => setOpen({ kind: 'item', id })} />}
      {tab === 'takes' && <Takes onOpen={(id) => setOpen({ kind: 'take', id })} onNew={() => setForm('take')} />}
      {tab === 'value' && costs && <Valuation onOpen={(id) => setOpen({ kind: 'item', id })} />}

      {open?.kind === 'item' && <ItemHistory id={open.id} onClose={() => setOpen(null)} onOpen={setOpen} onChanged={() => void items.reload()} />}
      {open?.kind === 'purchase' && <PurchaseDetail id={open.id} onClose={() => setOpen(null)} />}
      {open?.kind === 'take' && <TakeDetail id={open.id} onClose={() => setOpen(null)} />}
      {open?.kind === 'sale' && <SaleDrawer id={open.id} onClose={() => setOpen(null)} onChanged={() => void items.reload()} />}
      {form === 'purchase' && <PurchaseForm items={stocked} onClose={() => setForm(null)} onDone={done} onNewItem={() => void items.reload()} />}
      {form === 'return' && <ReturnForm items={stocked} onClose={() => setForm(null)} onDone={done} />}
      {form === 'credit' && <CreditForm onClose={() => setForm(null)} onDone={done} />}
      {form === 'take' && <TakeForm items={stocked} onClose={() => setForm(null)} onDone={done} />}
    </div>
  );
}

/** Where a supplier was paid from: a real account, or "Not paid yet" (a bill). */
function supplierSources(sources: { id: string; name: string; role?: string | null; active: boolean }[]) {
  return sources.filter((s) => s.active && (!s.role || s.role === 'bills'));
}

/* ------------------------------------------------------------------ stock */

function StockList({ items, onOpen }: { items: ReturnType<typeof useApi<Item[]>>; onOpen: (id: string) => void }) {
  const costs = useAuthed().can('stock.costs');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'in' | 'low' | 'out'>('all');
  const needle = search.trim().toLowerCase();
  const rows = (items.data ?? []).filter(
    (i) =>
      i.stocked &&
      (!needle || i.description.toLowerCase().includes(needle) || i.sku.toLowerCase().includes(needle)) &&
      (filter === 'all' ||
        (filter === 'in' && Number(i.qtyOnHand) > 0) ||
        (filter === 'out' && Number(i.qtyOnHand) <= 0) ||
        (filter === 'low' && Number(i.reorderLevel) > 0 && Number(i.qtyOnHand) <= Number(i.reorderLevel))),
  );
  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={18} />
          <input className="input" placeholder="Find an item or code" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find an item" />
        </div>
        <Segmented
          label="Which"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'in', label: 'In stock' },
            { value: 'low', label: 'To reorder' },
            { value: 'out', label: 'Not in stock' },
          ]}
        />
      </div>
      <ErrorBox error={items.error} onRetry={items.reload} />
      {items.loading && !items.data ? (
        <Loading />
      ) : rows.length ? (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">On hand</th>
                {costs && <th className="num">Average cost</th>}
                {costs && <th className="num">Value</th>}
                <th>Last moved</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const q = Number(i.qtyOnHand);
                const reorder = Number(i.reorderLevel) > 0 && q <= Number(i.reorderLevel);
                return (
                  <tr key={i.id} className={`clickable${i.active ? '' : ' inactive'}`} onClick={() => onOpen(i.id)}>
                    <td>
                      <button type="button" className="link-btn" onClick={() => onOpen(i.id)}>
                        {i.description}
                      </button>
                      {i.sku && <span className="xs muted"> · {i.sku}</span>}
                      {reorder && q >= 0 && <div className="xs warn-text">Reorder: down to {qtyText(q)}</div>}
                    </td>
                    <td className={`num ${q < 0 ? 'stock-neg' : ''}`}>{qtyText(q)}</td>
                    {costs && <td className="num">{i.averageCostCents != null ? <Money cents={i.averageCostCents} /> : <span className="muted">–</span>}</td>}
                    {costs && (
                      <td className="num">
                        <Money cents={i.stockValueCents} />
                      </td>
                    )}
                    <td className="small muted nowrap">{i.lastMoved ? formatDate(i.lastMoved) : 'Never'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty title={items.data?.some((i) => i.stocked) ? 'Nothing matches' : 'No stocked items yet'}>
            Add items under Sales → Items with <strong>Keep stock of it</strong> ticked, then bring stock in with a supplier invoice (or their opening stock).
          </Empty>
        </div>
      )}
    </div>
  );
}

/** One item's whole story: every movement, what caused it (linked), and the stock after each. */
function ItemHistory({ id, onClose, onOpen, onChanged }: { id: string; onClose: () => void; onOpen: (o: { kind: 'item' | 'purchase' | 'take' | 'sale'; id: string }) => void; onChanged: () => void }) {
  const { can, settings } = useAuthed();
  const isOwner = can('stock.buy') || can('items.edit');
  const costs = can('stock.costs');
  const { data, error, loading, reload } = useApi<{
    item: Item;
    moves: StockMove[];
    documents: { id: string; kind: string; number: string; counter: boolean; issueDate: string; status: string; qty: number; lineTotalCents: number; clientName: string | null }[];
    changes: { at: string; action: string; details: Record<string, unknown>; byName: string | null }[];
  }>(`/api/items/${id}/history`, { fresh: true });
  const [edit, setEdit] = useState(false);
  const [opening, setOpening] = useState(false);
  // The item's average cost now (the list works it out the same way).
  const it = data?.item ? { ...data.item, averageCostCents: Number(data.item.qtyOnHand) > 0 ? Math.round(Number(data.item.stockValueCents) / Number(data.item.qtyOnHand)) : null } : undefined;
  const vatRate = settings.vatRegistered ? vatRateOn(todayIso()) : 0;
  const changed = async () => {
    await reload();
    onChanged();
  };
  const source = (m: StockMove) => {
    if (m.documentId) {
      const label = m.documentKind === 'credit_note' ? `Credit note ${m.documentNumber}` : m.counter ? `Sale: invoice ${m.documentNumber}` : `Invoice ${m.documentNumber}`;
      return m.counter && m.documentKind !== 'credit_note' ? (
        <button type="button" className="link-btn" onClick={() => onOpen({ kind: 'sale', id: m.documentId! })}>
          {label}
        </button>
      ) : (
        <Link to={`/documents/${m.documentId}`}>{label}</Link>
      );
    }
    if (m.costId)
      return (
        <button type="button" className="link-btn" onClick={() => onOpen({ kind: 'purchase', id: m.costId! })}>
          {m.costSupplier}
          {m.costReference ? ` ${m.costReference}` : ''}
        </button>
      );
    if (m.stockTakeId)
      return (
        <button type="button" className="link-btn" onClick={() => onOpen({ kind: 'take', id: m.stockTakeId! })}>
          Count of {formatDate(m.date)}
        </button>
      );
    if (m.claimSupplier) return <>To {m.claimSupplier}</>;
    return null;
  };
  return (
    <Drawer title={it?.description ?? 'Item'} sub={it ? `${it.sku ? `${it.sku} · ` : ''}selling at ${formatZar(Number(it.unitPriceCents))}${it.priceIncludesVat && vatRate > 0 ? ' incl. VAT' : ''}` : undefined} onClose={onClose} wide>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data && it ? (
        <div className="stack">
          <div className="kpis compact">
            <Kpi label="On hand" value={qtyText(it.qtyOnHand)} tone={Number(it.qtyOnHand) < 0 ? 'bad' : undefined} />
            {costs && <Kpi label="Value at cost" value={<Money cents={it.stockValueCents} />} />}
            {costs && <Kpi label="Average cost" value={it.averageCostCents != null ? <Money cents={it.averageCostCents} /> : '–'} sub={Number(it.lastCostCents) ? <>Last bought at <Money cents={it.lastCostCents} /></> : undefined} />}
            <Kpi label="Selling (excl. VAT)" value={<Money cents={netPriceCents(it, vatRate)} />} tone={costs && it.averageCostCents != null && Number(it.averageCostCents) > netPriceCents(it, vatRate) ? 'bad' : undefined} sub={costs && it.averageCostCents != null && Number(it.averageCostCents) > netPriceCents(it, vatRate) ? 'Below cost: worth writing down at the count' : undefined} />
          </div>
          {isOwner && (
            <div className="row wrap">
              {can('items.edit') && (
                <button className="btn small" onClick={() => setEdit(true)}>
                  <Icon name="edit" size={16} />
                  Change the item
                </button>
              )}
              {data.moves.length === 0 && can('stock.buy') && (
                <button className="btn small" onClick={() => setOpening(true)}>
                  Stock already on hand
                </button>
              )}
            </div>
          )}
          {opening && <OpeningForm item={it} onCancel={() => setOpening(false)} onDone={async () => (setOpening(false), await changed())} />}
          <div>
            <h3 className="small strong">Movements</h3>
            <p className="xs muted">Newest recorded first. Each is valued when it’s recorded, at the average cost then, and never changed afterwards.</p>
          </div>
          {data.moves.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>What</th>
                    <th className="num">Qty</th>
                    {costs && <th className="num">At cost</th>}
                    <th className="num">On hand after</th>
                    {costs && <th className="num">Value after</th>}
                  </tr>
                </thead>
                <tbody>
                  {[...data.moves].reverse().map((m) => (
                    <tr key={m.id}>
                      <td className="nowrap small">{formatDate(m.date)}</td>
                      <td>
                        <div className="small">
                          {MOVE_LABELS[m.kind]} {source(m) && <>· {source(m)}</>}
                        </div>
                        {m.reason && <div className="xs muted">{m.reason}</div>}
                        <div className="xs faint">
                          {m.byName ?? 'Shap'} · {new Date(m.createdAt).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' })}
                        </div>
                      </td>
                      <td className={`num ${Number(m.qty) < 0 ? 'muted' : ''}`}>
                        {Number(m.qty) > 0 ? '+' : ''}
                        {qtyText(m.qty)}
                      </td>
                      {costs && (
                        <td className="num">
                          <Money cents={m.valueCents} />
                        </td>
                      )}
                      <td className={`num ${Number(m.qtyAfter) < 0 ? 'stock-neg' : ''}`}>{qtyText(m.qtyAfter)}</td>
                      {costs && (
                        <td className="num">
                          <Money cents={m.valueAfterCents} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">No movements yet. Stock comes in on a supplier invoice{can('stock.buy') ? ', or as stock already on hand' : ''}.</p>
          )}
          {data.changes.length > 0 && (
            <details>
              <summary className="small strong">Changes to the item ({data.changes.length})</summary>
              <ul className="stack-sm" style={{ paddingLeft: 18 }}>
                {data.changes.map((c, i) => (
                  <li key={i} className="xs">
                    {new Date(c.at).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' })} · {c.byName ?? 'Shap'}: {changeText(c.action, c.details)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : null}
      {edit && it && <ItemDrawer item={it} onClose={() => setEdit(false)} onSaved={() => void changed()} />}
    </Drawer>
  );
}

function changeText(action: string, d: Record<string, unknown>): string {
  if (action === 'create') return `added${d.stocked ? ', stock kept' : ''}`;
  if (action === 'opening_stock') return `stock already on hand: ${qtyText(Number(d.qty))} at ${formatZar(Number(d.valueCents))}`;
  if (action === 'update') {
    const parts: string[] = [];
    if (d.was && d.was !== d.description) parts.push(`renamed from “${String(d.was)}”`);
    if (d.wasPriceCents != null && d.priceCents !== d.wasPriceCents) parts.push(`price ${formatZar(Number(d.wasPriceCents))} → ${formatZar(Number(d.priceCents))}`);
    return parts.length ? parts.join('; ') : 'details changed';
  }
  if (action === 'stock_return') return `sent back to ${String(d.supplier)}: ${String(d.reason)}`;
  return action.replace(/_/g, ' ');
}

function OpeningForm({ item, onCancel, onDone }: { item: Item; onCancel: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState<number | null>(Number(item.lastCostCents) || null);
  const [from, setFrom] = useState<'costs' | 'opening_balances'>('costs');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api(`/api/items/${item.id}/opening`, { body: { date, qty: toQty(qty), unitCostCents: cost ?? 0, from } });
      toast('Stock on hand recorded');
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <form className="fieldset stack" onSubmit={submit}>
      <strong className="small">Stock already on hand</strong>
      <div className="form-grid">
        <Field label="How many">{(p) => <input {...p} className="input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} required />}</Field>
        <Field label="Cost each (excl. VAT)">{(p) => <MoneyInput {...p} value={cost} onChange={setCost} />}</Field>
        <Field label="As at">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
      </div>
      <Segmented
        label="Where it came from"
        value={from}
        onChange={setFrom}
        options={[
          { value: 'costs', label: 'Bought earlier (already in costs)' },
          { value: 'opening_balances', label: 'Part of the balances moved in' },
        ]}
      />
      <p className="xs muted">
        {from === 'costs'
          ? 'Its cost was booked as a cost when it was bought: it moves out of cost of sales into stock, and back when it sells.'
          : 'Stock from the books before Shap: it goes against the opening balances (Accounts → Opening balances).'}
      </p>
      {error && <div className="banner alert small">{error}</div>}
      <div className="row">
        <button type="button" className="btn quiet" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary grow">Save</button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ supplier invoices */

function Purchases({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error, loading, reload } = useApi<Purchase[]>('/api/stock/purchases');
  return (
    <div className="stack">
      <p className="small muted">
        A supplier’s invoice for stock: it’s a cost (paid, or a bill to pay) with its VAT on the VAT201, and what arrived goes into stock at its cost. What was invoiced but didn’t arrive becomes a claim on the supplier.
      </p>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.length ? (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Supplier</th>
                <th>Paid</th>
                <th className="num">Lines</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => onOpen(p.id)}>
                  <td className="nowrap">{formatDate(p.date)}</td>
                  <td>
                    <button type="button" className="link-btn" onClick={() => onOpen(p.id)}>
                      {p.supplier}
                    </button>
                    {p.reference && <span className="xs muted"> · {p.reference}</span>}
                    {Number(p.amountCents) < 0 && <div className="xs muted">Credit note</div>}
                  </td>
                  <td className="small">{p.sourceRole === 'bills' ? 'Not paid yet (a bill)' : p.sourceName}</td>
                  <td className="num">{p.lines || ''}</td>
                  <td className="num">
                    <Money cents={p.amountCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty title="No supplier invoices yet" />
        </div>
      )}
    </div>
  );
}

function PurchaseDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, loading, reload } = useApi<{
    cost: { id: string; date: string; supplier: string; billNumber: string; amountCents: number; vatCents: number; sourceName: string; receiptId: string | null; note: string; dueDate: string | null };
    lines: { id: string; description: string; unit: string; qtyInvoiced: number; qtyReceived: number; unitCostCents: number; lineCents: number; vatCode: PurchaseVatCode }[];
    claims: { id: string; kind: string; description: string; qty: number; valueCents: number; reason: string }[];
    settlements: { id: string; kind: string; amountCents: number; reason: string }[];
  }>(`/api/stock/purchases/${id}`, { fresh: true });
  const c = data?.cost;
  return (
    <Drawer title={c ? `${Number(c.amountCents) < 0 ? 'Credit from' : 'Invoice from'} ${c.supplier}` : 'Supplier invoice'} sub={c ? `${formatDate(c.date, 'long')}${c.billNumber ? ` · ${c.billNumber}` : ''}` : undefined} onClose={onClose} wide>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data && c ? (
        <div className="stack">
          <div className="small">
            <Money cents={c.amountCents} /> including <Money cents={c.vatCents} /> VAT · {c.sourceName}
            {c.dueDate ? ` · due ${formatDate(c.dueDate)}` : ''}
          </div>
          {c.receiptId && (
            <a className="btn small quiet" href={apiUrl(`/api/attachments/${c.receiptId}`)} target="_blank" rel="noreferrer">
              View the invoice
            </a>
          )}
          {data.lines.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Invoiced</th>
                    <th className="num">Arrived</th>
                    <th className="num">Each (excl. VAT)</th>
                    <th className="num">Line</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.description}
                        {l.vatCode !== 'standard' && <div className="xs muted">{PURCHASE_VAT[l.vatCode].label}</div>}
                      </td>
                      <td className="num">{qtyText(l.qtyInvoiced)}</td>
                      <td className={`num ${Number(l.qtyReceived) < Number(l.qtyInvoiced) ? 'warn-text' : ''}`}>{qtyText(l.qtyReceived)}</td>
                      <td className="num">
                        <Money cents={l.unitCostCents} />
                      </td>
                      <td className="num">
                        <Money cents={l.lineCents} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.claims.length > 0 && (
            <div className="stack-sm">
              <h3 className="small strong">Claims on the supplier</h3>
              {data.claims.map((x) => (
                <div key={x.id} className="small">
                  {x.kind === 'short' ? 'Short supplied' : 'Sent back'}: {qtyText(x.qty)} {x.description}, <Money cents={x.valueCents} /> · <span className="muted">{x.reason}</span>
                </div>
              ))}
            </div>
          )}
          {data.settlements.length > 0 && (
            <div className="stack-sm">
              <h3 className="small strong">What this credit settled</h3>
              {data.settlements.map((x) => (
                <div key={x.id} className="small">
                  {x.kind === 'discount' ? 'A discount on stock bought (to cost of sales)' : 'A claim'}: <Money cents={x.amountCents} /> · <span className="muted">{x.reason}</span>
                </div>
              ))}
            </div>
          )}
          {c.note && <p className="small muted">{c.note}</p>}
        </div>
      ) : null}
    </Drawer>
  );
}

interface PLine {
  key: number;
  itemId: string;
  qtyInvoiced: string;
  qtyReceived: string;
  short: boolean;
  unitCostCents: number | null;
  vatCode: PurchaseVatCode;
}
let pKey = 1;

function PurchaseForm({ items, onClose, onDone, onNewItem }: { items: Item[]; onClose: () => void; onDone: () => void; onNewItem: () => void }) {
  const { ref, settings } = useAuthed();
  const toast = useToast();
  const sources = supplierSources(ref.sources);
  const [date, setDate] = useState(todayIso());
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [sourceId, setSourceId] = useState(settings.defaultCostSourceId && sources.some((s) => s.id === settings.defaultCostSourceId) ? settings.defaultCostSourceId : (sources[0]?.id ?? ''));
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [lines, setLines] = useState<PLine[]>([{ key: pKey++, itemId: '', qtyInvoiced: '', qtyReceived: '', short: false, unitCostCents: null, vatCode: 'standard' }]);
  const [theirVat, setTheirVat] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState<number | null>(null);
  const rate = settings.vatRegistered ? vatRateOn(date) : 0;
  const bill = sources.find((s) => s.id === sourceId)?.role === 'bills';
  const upd = (key: number, patch: Partial<PLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const lineCents = (l: PLine) => Math.round(toQty(l.qtyInvoiced) * (l.unitCostCents ?? 0));
  const net = lines.reduce((t, l) => t + lineCents(l), 0);
  const vatWorked = Math.round((lines.filter((l) => rate > 0 && l.vatCode === 'standard').reduce((t, l) => t + lineCents(l), 0) * rate) / 10000);
  const vat = theirVat ?? vatWorked;

  const photo = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const r = await api<{ id: string }>('/api/attachments', { body: await compressSlip(file) });
      setReceiptId(r.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t upload it', 'error');
    } finally {
      setUploading(false);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const ready = lines.filter((l) => l.itemId);
    if (!ready.length) return setError('Add what was bought');
    setBusy(true);
    try {
      const r = await api<{ costId: string; claims: number }>('/api/stock/purchases', {
        body: {
          date,
          supplier,
          reference,
          sourceId,
          dueDate: bill && dueDate ? dueDate : null,
          receiptId,
          note,
          vatCents: rate > 0 && theirVat != null ? theirVat : undefined,
          lines: ready.map((l) => ({ itemId: l.itemId, qtyInvoiced: toQty(l.qtyInvoiced), qtyReceived: l.short ? toQty(l.qtyReceived) : undefined, unitCostCents: l.unitCostCents ?? 0, vatCode: rate > 0 ? l.vatCode : 'no_vat' })),
        },
      });
      toast(r.claims ? `In stock, with ${r.claims} short-supply claim${r.claims === 1 ? '' : 's'} on ${supplier}` : 'In stock');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
      setBusy(false);
    }
  };
  return (
    <Drawer title="Supplier invoice for stock" sub="What was invoiced, and what arrived" onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Supplier">{(p) => <input {...p} className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} required autoFocus />}</Field>
          <Field label="Their invoice number">{(p) => <input {...p} className="input" value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
          <Field label="Invoice date">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
        </div>
        <div className="form-grid">
          <Field label="Paid from">
            {(p) => (
              <select {...p} className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.role === 'bills' ? 'Not paid yet (a bill)' : s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {bill && <Field label="Due on">{(p) => <input {...p} className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}</Field>}
        </div>
        <div className="stack-sm">
          <span className="label">What’s on the invoice</span>
          {lines.map((l, i) => {
            const it = items.find((x) => x.id === l.itemId);
            return (
              <div key={l.key} className="fieldset stack-sm">
                <div className="row wrap" style={{ gap: 8 }}>
                  <select className="select grow" value={l.itemId} onChange={(e) => (e.target.value === '__new' ? setNewItem(l.key) : upd(l.key, { itemId: e.target.value, unitCostCents: l.unitCostCents ?? (Number(items.find((x) => x.id === e.target.value)?.lastCostCents) || null) }))} aria-label={`Item ${i + 1}`}>
                    <option value="">Choose the item…</option>
                    {items
                      .filter((x) => x.active || x.id === l.itemId)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.description}
                          {x.sku ? ` (${x.sku})` : ''}
                        </option>
                      ))}
                    <option value="__new">+ A new item…</option>
                  </select>
                  {lines.length > 1 && (
                    <button type="button" className="btn quiet small" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Take this line off">
                      <Icon name="close" size={16} />
                    </button>
                  )}
                </div>
                <div className="row wrap" style={{ gap: 8, alignItems: 'end' }}>
                  <Field label="Qty invoiced" className="small-input">
                    {(p) => <input {...p} className="input input-sm" inputMode="decimal" value={l.qtyInvoiced} onChange={(e) => upd(l.key, { qtyInvoiced: e.target.value })} style={{ width: 90 }} />}
                  </Field>
                  <Field label={rate > 0 ? 'Each, excl. VAT' : 'Each'}>{(p) => <MoneyInput {...p} value={l.unitCostCents} onChange={(c) => upd(l.key, { unitCostCents: c })} />}</Field>
                  {rate > 0 && (
                    <Field label="VAT">
                      {(p) => (
                        <select {...p} className="select" value={l.vatCode} onChange={(e) => upd(l.key, { vatCode: e.target.value as PurchaseVatCode })}>
                          {PURCHASE_VAT_CODES.map((c) => (
                            <option key={c} value={c}>
                              {PURCHASE_VAT[c].label}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  )}
                  <span className="grow" />
                  <Money cents={lineCents(l)} />
                </div>
                <label className="check xs">
                  <input type="checkbox" checked={l.short} onChange={(e) => upd(l.key, { short: e.target.checked, qtyReceived: e.target.checked ? l.qtyReceived || '0' : '' })} />
                  Short supplied (not all of it arrived)
                </label>
                {l.short && (
                  <Field label="How many arrived" hint={it ? `The rest (${qtyText(Math.max(0, toQty(l.qtyInvoiced) - toQty(l.qtyReceived)))}) is claimed from ${supplier || 'the supplier'}` : undefined}>
                    {(p) => <input {...p} className="input input-sm" inputMode="decimal" value={l.qtyReceived} onChange={(e) => upd(l.key, { qtyReceived: e.target.value })} style={{ width: 90 }} />}
                  </Field>
                )}
              </div>
            );
          })}
          <button type="button" className="btn small" onClick={() => setLines((ls) => [...ls, { key: pKey++, itemId: '', qtyInvoiced: '', qtyReceived: '', short: false, unitCostCents: null, vatCode: 'standard' }])}>
            <Icon name="plus" size={16} />
            Another line
          </button>
        </div>
        <dl className="totals">
          <div className="spread">
            <dt className="small muted">{rate > 0 ? 'Excluding VAT' : 'Total'}</dt>
            <dd>
              <Money cents={net} />
            </dd>
          </div>
          {rate > 0 && (
            <>
              <div className="spread">
                <dt className="small muted">VAT</dt>
                <dd>
                  <Money cents={vat} />
                </dd>
              </div>
              <div className="spread">
                <dt className="strong">Invoice total</dt>
                <dd className="strong">
                  <Money cents={net + vat} />
                </dd>
              </div>
            </>
          )}
        </dl>
        {rate > 0 && (
          <details>
            <summary className="xs muted">Their VAT differs by a cent or two?</summary>
            <Field label="VAT as on their invoice" hint={`Shap works it out at ${formatZar(vatWorked)}. Their rounding may differ by a cent a line.`}>
              {(p) => <MoneyInput {...p} value={theirVat} onChange={setTheirVat} />}
            </Field>
          </details>
        )}
        <div className="field">
          <span className="label">Their invoice</span>
          <div className="row wrap">
            <label className="btn">
              <Icon name="camera" size={18} />
              {receiptId ? 'Replace' : 'Photo or PDF of the invoice'}
              <input type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(e) => void photo(e.target.files?.[0])} />
            </label>
            {uploading && <span className="small muted">Uploading…</span>}
          </div>
        </div>
        <Field label="Note (optional)">{(p) => <input {...p} className="input" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block" disabled={busy}>
          <Icon name="check" size={18} />
          {busy ? 'Saving…' : 'Into stock'}
        </button>
      </form>
      {newItem != null && (
        <ItemDrawer
          item={null}
          onClose={() => setNewItem(null)}
          onSaved={(it) => {
            onNewItem();
            if (it) upd(newItem, { itemId: it.id });
          }}
        />
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ returns and claims */

function Claims({ onReturn, onCredit, onOpenItem }: { onReturn: () => void; onCredit: () => void; onOpenItem: (id: string) => void }) {
  const isOwner = useAuthed().can('stock.buy');
  const [state, setState] = useState<'open' | 'all'>('open');
  const { data, error, loading, reload } = useApi<Claim[]>(`/api/stock/claims?state=${state}`);
  const [writeOff, setWriteOff] = useState<Claim | null>(null);
  const owed = (data ?? []).reduce((t, c) => t + Number(c.leftCents), 0);
  return (
    <div className="stack">
      <p className="small muted">
        Stock sent back (received in bad order, the wrong item) and stock invoiced but never delivered are claims on the supplier until their credit note settles them. One they won’t settle is written off to stock losses.
      </p>
      <div className="toolbar">
        <Segmented
          label="Which claims"
          value={state}
          onChange={setState}
          options={[
            { value: 'open', label: 'Still owed' },
            { value: 'all', label: 'All' },
          ]}
        />
        {isOwner && (
          <>
            <button className="btn small" onClick={onReturn}>
              Send stock back
            </button>
            <button className="btn small" onClick={onCredit}>
              Supplier credit note
            </button>
          </>
        )}
      </div>
      {state === 'open' && data && data.length > 0 && (
        <p className="small">
          Owed back by suppliers: <Money cents={owed} />
        </p>
      )}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.length ? (
        <ul className="panel list">
          {data.map((c) => (
            <li key={c.id} className="list-row">
              <div className="grow">
                <strong className="small">{c.supplier}</strong>
                <div className="xs muted">
                  {c.kind === 'short' ? 'Short supplied' : 'Sent back'} {formatDate(c.date)}: {qtyText(c.qty)} ×{' '}
                  <button type="button" className="link-btn" onClick={() => onOpenItem(c.itemId)}>
                    {c.description}
                  </button>
                </div>
                {c.settlements.map((s) => (
                  <div key={s.id} className="xs muted">
                    {s.kind === 'write_off' ? 'Written off' : `Credited${s.creditReference ? ` (${s.creditReference})` : ''}`} {formatDate(s.date)}: <Money cents={s.amountCents} />
                    {s.kind === 'write_off' && s.reason ? ` · ${s.reason}` : ''}
                  </div>
                ))}
              </div>
              <div className="stack-sm" style={{ justifyItems: 'end' }}>
                <strong>
                  <Money cents={c.leftCents} />
                </strong>
                {Number(c.leftCents) < Number(c.valueCents) && Number(c.leftCents) > 0 && (
                  <span className="xs muted">
                    of <Money cents={c.valueCents} />
                  </span>
                )}
                {isOwner && Number(c.leftCents) > 0 && (
                  <button className="btn quiet small" onClick={() => setWriteOff(c)}>
                    Write off
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="panel">
          <Empty title={state === 'open' ? 'Nothing owed back' : 'No claims yet'} />
        </div>
      )}
      {writeOff && <WriteOff claim={writeOff} onClose={() => setWriteOff(null)} onDone={() => (setWriteOff(null), void reload())} />}
    </div>
  );
}

function WriteOff({ claim, onClose, onDone }: { claim: Claim; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/stock/claims/${claim.id}/write-off`, { body: { date, reason } });
      toast('Written off to stock losses');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t write it off');
    }
  };
  return (
    <Drawer title={`Write off the claim on ${claim.supplier}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small">
          <Money cents={claim.leftCents} /> for {qtyText(claim.qty)} × {claim.description} goes to stock losses: the supplier won’t credit it.
        </p>
        <Field label="Why">{(p) => <input {...p} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Supplier refused: damage not reported in time" required />}</Field>
        <Field label="On">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Write it off</button>
      </form>
    </Drawer>
  );
}

function ReturnForm({ items, onClose, onDone }: { items: Item[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const purchases = useApi<Purchase[]>('/api/stock/purchases');
  const [date, setDate] = useState(todayIso());
  const [itemId, setItemId] = useState('');
  const [costId, setCostId] = useState('');
  const [supplier, setSupplier] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const it = items.find((i) => i.id === itemId);
  const fromPurchase = (purchases.data ?? []).filter((p) => Number(p.amountCents) > 0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/api/stock/returns', { body: { date, supplier, costId: costId || null, itemId, qty: toQty(qty), reason } });
      toast(`Sent back: a claim on ${supplier}`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title="Send stock back to the supplier" sub="Received in bad order, or the wrong item" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Item">
          {(p) => (
            <select {...p} className="select" value={itemId} onChange={(e) => setItemId(e.target.value)} required>
              <option value="">Choose…</option>
              {items
                .filter((i) => Number(i.qtyOnHand) > 0)
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.description} ({qtyText(i.qtyOnHand)} on hand)
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Field label="The invoice it came on (optional)" hint="It goes back at what it’s worth in stock (average cost); their credit note settles the claim, anything more a discount">
          {(p) => (
            <select
              {...p}
              className="select"
              value={costId}
              onChange={(e) => {
                setCostId(e.target.value);
                const pc = fromPurchase.find((x) => x.id === e.target.value);
                if (pc) setSupplier(pc.supplier);
              }}
            >
              <option value="">Not sure</option>
              {fromPurchase.map((pc) => (
                <option key={pc.id} value={pc.id}>
                  {formatDate(pc.date)} · {pc.supplier}
                  {pc.reference ? ` ${pc.reference}` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="form-grid">
          <Field label="Supplier">{(p) => <input {...p} className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} required />}</Field>
          <Field label="How many" hint={it ? `${qtyText(it.qtyOnHand)} on hand` : undefined}>
            {(p) => <input {...p} className="input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} required />}
          </Field>
        </div>
        <Field label="Why it’s going back">{(p) => <input {...p} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Arrived broken" required />}</Field>
        <Field label="Sent back on">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Send it back</button>
      </form>
    </Drawer>
  );
}

function CreditForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { ref, settings } = useAuthed();
  const toast = useToast();
  const claims = useApi<Claim[]>('/api/stock/claims?state=open');
  const sources = supplierSources(ref.sources);
  const [date, setDate] = useState(todayIso());
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [sourceId, setSourceId] = useState(sources.find((s) => s.role === 'bills')?.id ?? sources[0]?.id ?? '');
  const [amount, setAmount] = useState<number | null>(null);
  const [vatCents, setVatCents] = useState<number | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [billId, setBillId] = useState('');
  const [error, setError] = useState('');
  const rate = settings.vatRegistered ? vatRateOn(date) : 0;
  const offOwed = sources.find((x) => x.id === sourceId)?.role === 'bills';
  const openBills = useApi<{ id: string; supplier: string; billNumber: string; description: string; date: string; owingCents: number }[]>(offOwed ? '/api/bills?state=open' : null);
  const theirBills = (openBills.data ?? []).filter((b) => b.supplier.trim().toLowerCase() === supplier.trim().toLowerCase());
  const theirs = (claims.data ?? []).filter((c) => !supplier.trim() || c.supplier.trim().toLowerCase() === supplier.trim().toLowerCase());
  const suppliers = [...new Set((claims.data ?? []).map((c) => c.supplier))];
  const chosen = theirs.filter((c) => picked.includes(c.id)).reduce((t, c) => t + Number(c.leftCents), 0);
  const vat = rate > 0 ? (vatCents ?? Math.round(((amount ?? 0) * rate) / (10000 + rate))) : 0;
  const net = (amount ?? 0) - vat;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ settled: number; discountCents: number }>('/api/stock/credits', {
        body: { date, supplier, reference, sourceId, amountCents: amount ?? 0, vatCents: vat, vatCode: rate > 0 && vat > 0 ? 'standard' : 'no_vat', claimIds: picked, note, billId: offOwed && billId ? billId : null },
      });
      toast(`${r.settled} claim${r.settled === 1 ? '' : 's'} settled${r.discountCents ? `, ${formatZar(r.discountCents)} a discount` : ''}`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title="A supplier’s credit note" sub="What it settles of the claims on them" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Supplier">
            {(p) => (
              <>
                <input {...p} className="input" list="claim-suppliers" value={supplier} onChange={(e) => (setSupplier(e.target.value), setPicked([]))} required autoFocus />
                <datalist id="claim-suppliers">
                  {suppliers.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Their credit note number">{(p) => <input {...p} className="input" value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
        </div>
        <div className="form-grid">
          <Field label="Amount, including VAT">{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
          {rate > 0 && <Field label="VAT on it" hint="As on their credit note">{(p) => <MoneyInput {...p} value={vatCents ?? (amount ? vat : null)} onChange={setVatCents} />}</Field>}
          <Field label="Dated">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
        </div>
        <Field label="The money" hint="Off what’s owed to them (a bill), or paid back into an account">
          {(p) => (
            <select {...p} className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.role === 'bills' ? 'Off what’s owed to them' : `Paid back into ${s.name}`}
                </option>
              ))}
            </select>
          )}
        </Field>
        {offOwed && (
          <Field label="Take it off their bill" hint="So the bill shows that much less owed">
            {(p) => (
              <select {...p} className="select" value={billId} onChange={(e) => setBillId(e.target.value)}>
                <option value="">Not now (it waits under Bills to pay)</option>
                {theirBills.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.billNumber || b.description} · {formatDate(b.date)} · owing {formatZar(Number(b.owingCents))}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <div className="stack-sm">
          <span className="label">Claims it settles</span>
          {theirs.length ? (
            theirs.map((c) => (
              <label key={c.id} className="check small">
                <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, c.id] : x.filter((y) => y !== c.id)))} />
                <span>
                  {c.supplier}: {c.kind === 'short' ? 'short supplied' : 'sent back'} {formatDate(c.date)}, {qtyText(c.qty)} × {c.description} · <Money cents={c.leftCents} />
                </span>
              </label>
            ))
          ) : (
            <p className="xs muted">No claims on {supplier || 'them'} still owed: the whole credit is a discount on stock bought.</p>
          )}
        </div>
        {amount != null && amount > 0 && (
          <p className="xs muted">
            Excluding VAT it’s <Money cents={net} />. {chosen > 0 ? <>The claims chosen come to <Money cents={chosen} />. </> : null}
            {net > chosen ? <>Anything beyond them (<Money cents={net - chosen} />) lowers the cost of what was sold. </> : null}
            {net < chosen ? <>The rest of the claims stays owed.</> : null}
          </p>
        )}
        <Field label="Note (optional)">{(p) => <input {...p} className="input" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block" disabled={!amount}>
          Save the credit
        </button>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ stock takes */

function Takes({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const { can } = useAuthed();
  const isOwner = can('stock.count');
  const costs = can('stock.costs');
  const { data, error, loading, reload } = useApi<Take[]>('/api/stock/takes');
  return (
    <div className="stack">
      <p className="small muted">A count of what’s on the shelf. Each difference is corrected at average cost, with the reason, into stock losses (or gains), and the count itself is kept: who counted, when, and what Shap had.</p>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.length ? (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Counted by</th>
                <th className="num">Items</th>
                <th className="num">Corrected</th>
                {costs && <th className="num">Gain (loss)</th>}
              </tr>
            </thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => onOpen(t.id)}>
                  <td>
                    <button type="button" className="link-btn" onClick={() => onOpen(t.id)}>
                      {formatDate(t.date)}
                    </button>
                    {t.note && <div className="xs muted">{t.note}</div>}
                  </td>
                  <td className="small">{t.byName}</td>
                  <td className="num">{t.items}</td>
                  <td className="num">{t.corrected}</td>
                  {costs && (
                    <td className="num">
                      <Money cents={t.valueCents} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty title="No stock takes yet">
            {isOwner && (
              <button className="btn small" onClick={onNew}>
                Count stock
              </button>
            )}
          </Empty>
        </div>
      )}
    </div>
  );
}

function TakeDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const costs = useAuthed().can('stock.costs');
  const { data, error, loading, reload } = useApi<{
    take: Take;
    lines: { id: string; itemId: string; description: string; unit: string; systemQty: number; countedQty: number; reason: string; valueCents: number | null }[];
  }>(`/api/stock/takes/${id}`, { fresh: true });
  return (
    <Drawer title={data ? `Stock take of ${formatDate(data.take.date, 'long')}` : 'Stock take'} sub={data ? `Counted by ${data.take.byName ?? '–'}` : undefined} onClose={onClose} wide>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data ? (
        <div className="stack">
          {data.take.note && <p className="small">{data.take.note}</p>}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Shap had</th>
                  <th className="num">Counted</th>
                  <th className="num">Difference</th>
                  {costs && <th className="num">At cost</th>}
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => {
                  const diff = Number(l.countedQty) - Number(l.systemQty);
                  return (
                    <tr key={l.id}>
                      <td>
                        {l.description}
                        {l.reason && <div className="xs muted">{l.reason}</div>}
                      </td>
                      <td className="num">{qtyText(l.systemQty)}</td>
                      <td className="num">{qtyText(l.countedQty)}</td>
                      <td className={`num ${diff < 0 ? 'warn-text' : ''}`}>{diff === 0 ? '–' : `${diff > 0 ? '+' : ''}${qtyText(diff)}`}</td>
                      {costs && <td className="num">{l.valueCents != null ? <Money cents={l.valueCents} /> : ''}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

function TakeForm({ items, onClose, onDone }: { items: Item[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [counts, setCounts] = useState<Record<string, { qty: string; reason: string }>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = items.filter((i) => i.active || Number(i.qtyOnHand) !== 0);
  const needle = search.trim().toLowerCase();
  const shown = active.filter((i) => !needle || i.description.toLowerCase().includes(needle) || i.sku.toLowerCase().includes(needle));
  const entered = active.filter((i) => (counts[i.id]?.qty ?? '').trim() !== '');
  const differs = entered.filter((i) => toQty(counts[i.id]!.qty) !== Number(i.qtyOnHand));
  const set = (id: string, patch: Partial<{ qty: string; reason: string }>) => setCounts((c) => ({ ...c, [id]: { qty: c[id]?.qty ?? '', reason: c[id]?.reason ?? '', ...patch } }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!entered.length) return setError('Count at least one item');
    const missing = differs.find((i) => (counts[i.id]?.reason ?? '').trim().length < 2 && note.trim().length < 2);
    if (missing) return setError(`Say why ${missing.description} differs (stolen, damaged, miscounted…), or give one reason for the whole count`);
    setBusy(true);
    try {
      const r = await api<{ corrected: number; valueCents: number }>('/api/stock/takes', {
        body: { date, note, lines: entered.map((i) => ({ itemId: i.id, countedQty: toQty(counts[i.id]!.qty), reason: counts[i.id]!.reason })) },
      });
      toast(r.corrected ? (r.valueCents == null ? `${r.corrected} corrected` : `${r.corrected} corrected: ${formatZar(r.valueCents)} to stock ${r.valueCents < 0 ? 'losses' : 'gains'}`) : 'Counted: everything agrees');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save the count');
      setBusy(false);
    }
  };
  return (
    <Drawer title="Count stock" sub="Type what’s on the shelf. Items left blank aren’t part of this count." onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Counted on" hint="Movements after this date are left as they are">
            {(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} max={todayIso()} required />}
          </Field>
          <Field label="About this count (optional)" hint="Also the reason for any difference without its own">
            {(p) => <input {...p} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Month-end count" />}
          </Field>
        </div>
        <div className="toolbar">
          <div className="search">
            <Icon name="search" size={18} />
            <input className="input" placeholder="Find an item" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find an item" />
          </div>
          <button type="button" className="btn small quiet" onClick={() => setCounts(Object.fromEntries(active.map((i) => [i.id, { qty: counts[i.id]?.qty || qtyText(Math.max(0, Number(i.qtyOnHand))), reason: counts[i.id]?.reason ?? '' }])))}>
            Fill in what Shap has
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Shap has</th>
                <th className="num">Counted</th>
                <th>Why it differs</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => {
                const c = counts[i.id];
                const diff = c && c.qty.trim() !== '' ? toQty(c.qty) - Number(i.qtyOnHand) : 0;
                return (
                  <tr key={i.id}>
                    <td>
                      {i.description}
                      {i.sku && <div className="xs muted">{i.sku}</div>}
                    </td>
                    <td className={`num ${Number(i.qtyOnHand) < 0 ? 'stock-neg' : ''}`}>{qtyText(i.qtyOnHand)}</td>
                    <td className="num">
                      <input className="input input-sm" inputMode="decimal" value={c?.qty ?? ''} onChange={(e) => set(i.id, { qty: e.target.value })} aria-label={`Counted ${i.description}`} style={{ width: 80, textAlign: 'right' }} />
                      {diff !== 0 && <div className={`xs ${diff < 0 ? 'warn-text' : 'ok-text'}`}>{diff > 0 ? '+' : ''}{qtyText(diff)}</div>}
                    </td>
                    <td>{diff !== 0 && <input className="input input-sm" value={c?.reason ?? ''} onChange={(e) => set(i.id, { reason: e.target.value })} placeholder="Stolen, damaged, miscounted…" aria-label={`Why ${i.description} differs`} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          {entered.length} counted, {differs.length} differ{differs.length === 1 ? 's' : ''}.
        </p>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block" disabled={busy || !entered.length}>
          {busy ? 'Saving…' : 'Save the count'}
        </button>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ valuation */

function Valuation({ onOpen }: { onOpen: (id: string) => void }) {
  const { settings, can } = useAuthed();
  const toast = useToast();
  const [writing, setWriting] = useState(false);
  const [date, setDate] = useState(todayIso());
  const { data, error, loading, reload } = useApi<{ date: string; totalCents: number; rows: { id: string; description: string; sku: string; unit: string; qty: number; valueCents: number; unitPriceCents: number; priceIncludesVat: boolean; vatCode: 'standard' | 'zero' | 'export' | 'exempt' }[] }>(
    `/api/stock/valuation?date=${date}`,
  );
  const rate = settings.vatRegistered ? vatRateOn(date) : 0;
  const above = (data?.rows ?? []).filter((r) => Number(r.qty) > 0 && Number(r.valueCents) > Number(r.qty) * netPriceCents(r, rate));
  return (
    <div className="stack">
      <div className="toolbar">
        <Field label="As at">{(p) => <input {...p} className="input input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value || todayIso())} />}</Field>
      </div>
      <p className="small muted">Each item’s quantity and value from its movements up to the date, at weighted average cost: what the financial statements carry as inventories (IFRS for SMEs section 13).</p>
      {above.length > 0 && (
        <div className="banner signal small stack-sm">
          <span>
            {above.length} item{above.length === 1 ? ' is' : 's are'} carried above what {above.length === 1 ? 'it' : 'they'} would sell for. Stock is carried at the lower of cost and selling price less the costs to sell (IFRS for SMEs 13.19 and 27.2): write the difference down, or check the price.
          </span>
          {can('stock.buy') && date === todayIso() && (
            <button
              type="button"
              className="btn small start"
              disabled={writing}
              onClick={async () => {
                if (!confirm(`Write ${above.length === 1 ? 'it' : 'them'} down to the selling price (VAT excluded), into stock losses? The selling price is used as what ${above.length === 1 ? 'it' : 'they'} will sell for: if selling costs something too, write down further at a count.`)) return;
                setWriting(true);
                try {
                  const r = await api<{ written: number; valueCents: number }>('/api/stock/write-downs', {
                    body: { date, lines: above.map((x) => ({ itemId: x.id, unitValueCents: netPriceCents(x, rate), reason: 'Written down to its selling price (IFRS for SMEs 27.2)' })) },
                  });
                  toast(`${r.written} written down: ${formatZar(-r.valueCents)} to stock losses`);
                  await reload();
                } catch (err) {
                  toast(err instanceof ApiError ? err.message : 'Couldn’t write it down', 'error');
                } finally {
                  setWriting(false);
                }
              }}
            >
              Write {above.length === 1 ? 'it' : 'them'} down to the selling price
            </button>
          )}
        </div>
      )}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.rows.length ? (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Average cost</th>
                <th className="num">Value</th>
                <th className="num">Selling (excl. VAT)</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const q = Number(r.qty);
                const flag = above.includes(r);
                return (
                  <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                    <td>
                      {r.description}
                      {flag && <div className="xs warn-text">Above selling price</div>}
                    </td>
                    <td className={`num ${q < 0 ? 'stock-neg' : ''}`}>{qtyText(q)}</td>
                    <td className="num">{q > 0 ? <Money cents={Math.round(Number(r.valueCents) / q)} /> : '–'}</td>
                    <td className="num">
                      <Money cents={r.valueCents} />
                    </td>
                    <td className="num">
                      <Money cents={netPriceCents(r, rate)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tbody>
              <tr className="grand">
                <td colSpan={3}>Inventories at {formatDate(data.date, 'long')}</td>
                <td className="num">
                  <Money cents={data.totalCents} />
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty title="No stock to value" />
        </div>
      )}
    </div>
  );
}
