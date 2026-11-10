/**
 * Sales at the counter (docs/SALES_AND_STOCK.md): pick what's sold from the item list, take the
 * money, hand over the slip. A walk-in needs no details; a regular or a big buyer gets a tax
 * invoice, at the time or afterwards. Refunds take back what came back (into stock, or not if it
 * came back damaged). A sale is never changed or deleted: a mistake is refunded.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  documentTotals,
  formatDate,
  formatZar,
  FULL_TAX_INVOICE_CENTS,
  LINE_CATEGORIES,
  lineLabel,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  SALE_VAT,
  SALE_VAT_CODES,
  todayIso,
  vatRateOn,
  type LineCategory,
  type PaymentMethod,
  type SaleVatCode,
} from '@shap/shared';
import { PageHead } from '../components/Shell';
import { PdfPreview } from '../components/PdfPreview';
import { Drawer, Empty, ErrorBox, Field, Icon, Loading, Money, MoneyInput, Segmented, Tabs, useToast } from '../components/ui';
import { api, ApiError, apiBlob } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { ClientRow, Source } from '../lib/types';
import { qtyText, shelfPriceCents, toQty, type Item, type SaleDetail, type SaleRow } from '../lib/selling';
import { sharePdf } from '../lib/share-pdf';

type Tab = 'sell' | 'sales' | 'items';

export default function SalesPage() {
  const { isOwner, has } = useAuthed();
  const [tab, setTab] = useState<Tab>(isOwner ? 'sell' : 'sales');
  const today = useApi<{ count: number; totalCents: number; refundedCents: number }>('/api/sales-today');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="stack-lg">
      <PageHead
        title="Sales"
        sub={
          today.data ? (
            <>
              Today: {today.data.count} sale{today.data.count === 1 ? '' : 's'}, <Money cents={today.data.totalCents} />
              {today.data.refundedCents > 0 && (
                <>
                  {' '}
                  (<Money cents={today.data.refundedCents} /> refunded)
                </>
              )}
            </>
          ) : undefined
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[...(isOwner ? [{ value: 'sell' as const, label: 'Sell' }] : []), { value: 'sales' as const, label: 'Sales' }, { value: 'items' as const, label: has('inventory') ? 'Items and prices' : 'Items' }]}
      />
      {tab === 'sell' && isOwner && <Till onSold={(id) => (void today.reload(), setOpen(id))} />}
      {tab === 'sales' && <SalesList onOpen={setOpen} />}
      {tab === 'items' && <ItemList />}
      {open && <SaleDrawer id={open} onClose={() => setOpen(null)} onChanged={() => void today.reload()} />}
    </div>
  );
}

/* ------------------------------------------------------------------ the till */

interface CartLine {
  key: number;
  itemId: string | null;
  description: string;
  qty: string;
  unit: string;
  unitPriceCents: number | null;
  vatCode: SaleVatCode;
  category: LineCategory;
  stocked: boolean;
  onHand: number | null;
}

let nextKey = 1;

/** Where the money from a sale goes: real accounts only (Shap's own credit-note and bills sources aren't). */
export function counterSources(sources: Source[]): Source[] {
  return sources.filter((s) => s.active && !s.role);
}

/** The usual account for a way of paying: the till for cash, the bank for the rest. */
export function sourceFor(method: PaymentMethod, sources: Source[]): string {
  const real = counterSources(sources);
  const till = real.find((s) => s.till) ?? real.find((s) => s.kind === 'cash');
  const bank = real.find((s) => s.kind === 'bank');
  return (method === 'cash' ? till : bank)?.id ?? real[0]?.id ?? '';
}

function Till({ onSold }: { onSold: (id: string) => void }) {
  const { ref, settings, has, refreshReference } = useAuthed();
  const toast = useToast();
  const inventory = has('inventory');
  const items = useApi<Item[]>('/api/items?active=1');
  const [search, setSearch] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'in' | 'out'>('all');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [sourceId, setSourceId] = useState(() => sourceFor('cash', ref.sources));
  const [reference, setReference] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [asInvoice, setAsInvoice] = useState(false);
  const [clientId, setClientId] = useState('');
  const [tendered, setTendered] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; saleNumber: string; number: string; kind: 'sale' | 'invoice'; totalCents: number; change: number | null } | null>(null);
  const [preview, setPreview] = useState<{ id: string; title: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const vatRate = settings.vatRegistered ? vatRateOn(date) : 0;
  const sources = counterSources(ref.sources);
  const needle = search.trim().toLowerCase();
  const shown = (items.data ?? []).filter(
    (it) =>
      (!needle || it.description.toLowerCase().includes(needle) || it.sku.toLowerCase().includes(needle)) &&
      (stockFilter === 'all' || (it.stocked && (stockFilter === 'in' ? Number(it.qtyOnHand) > 0 : Number(it.qtyOnHand) <= 0))),
  );
  const totals = documentTotals(
    cart.map((l) => ({ qty: toQty(l.qty), unitPriceCents: l.unitPriceCents ?? 0, vatCode: l.vatCode })),
    vatRate,
    true,
  );
  const exported = vatRate > 0 && cart.some((l) => l.vatCode === 'export');
  const fullInvoice = vatRate > 0 && (totals.totalCents > FULL_TAX_INVOICE_CENTS || exported);
  const needsClient = fullInvoice || asInvoice;

  const add = (it: Item) => {
    setDone(null);
    setCart((c) => {
      const at = c.findIndex((l) => l.itemId === it.id);
      if (at >= 0) return c.map((l, i) => (i === at ? { ...l, qty: qtyText(toQty(l.qty) + 1) } : l));
      return [
        ...c,
        {
          key: nextKey++,
          itemId: it.id,
          description: it.description,
          qty: '1',
          unit: it.unit,
          unitPriceCents: shelfPriceCents(it, vatRate),
          vatCode: vatRate > 0 ? it.vatCode : 'standard',
          category: it.category,
          stocked: it.stocked,
          onHand: it.stocked ? Number(it.qtyOnHand) : null,
        },
      ];
    });
  };
  const addFree = () => {
    setDone(null);
    setCart((c) => [...c, { key: nextKey++, itemId: null, description: '', qty: '1', unit: '', unitPriceCents: null, vatCode: 'standard', category: 'goods', stocked: false, onHand: null }]);
  };
  const upd = (key: number, patch: Partial<CartLine>) => setCart((c) => c.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const drop = (key: number) => setCart((c) => c.filter((l) => l.key !== key));
  const pickMethod = (m: PaymentMethod) => {
    setMethod(m);
    setSourceId(sourceFor(m, ref.sources));
    if (m !== 'cash') setTendered(null);
  };

  const sell = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!cart.length) return setError('Add something to sell');
    if (needsClient && !clientId) return setError(fullInvoice ? (exported ? 'An export needs a full tax invoice: choose the customer.' : 'Over R5 000 SARS wants a full tax invoice: choose the customer.') : 'Choose the customer for the invoice');
    setBusy(true);
    try {
      const made = await api<{ id: string; number: string; saleNumber: string; kind: 'sale' | 'invoice' }>('/api/sales', {
        body: {
          date,
          sourceId,
          method,
          reference,
          pricesIncludeVat: true,
          customerName: needsClient ? '' : customerName.trim(),
          clientId: needsClient ? clientId : null,
          lines: cart.map((l) => ({ itemId: l.itemId, description: l.description.trim() || 'Sale', qty: toQty(l.qty), unit: l.unit, unitPriceCents: l.unitPriceCents ?? 0, vatCode: l.vatCode, category: l.category })),
        },
      });
      setDone({ ...made, totalCents: totals.totalCents, change: method === 'cash' && tendered != null && tendered >= totals.totalCents ? tendered - totals.totalCents : null });
      toast(`Sold: ${made.saleNumber}`);
      setCart([]);
      setCustomerName('');
      setReference('');
      setTendered(null);
      setAsInvoice(false);
      setClientId('');
      void items.reload();
      await refreshReference();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save the sale');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="till">
      <section className="stack" aria-label="Items">
        <div className="toolbar">
          <div className="search">
            <Icon name="search" size={18} />
            <input className="input" placeholder="Find an item or code" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find an item" />
          </div>
          {inventory && (
            <Segmented
              label="Stock"
              value={stockFilter}
              onChange={setStockFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'in', label: 'In stock' },
                { value: 'out', label: 'Not in stock' },
              ]}
            />
          )}
        </div>
        <ErrorBox error={items.error} onRetry={items.reload} />
        {items.loading && !items.data ? (
          <Loading />
        ) : shown.length ? (
          <div className="item-grid">
            {shown.map((it) => {
              const inCart = cart.find((l) => l.itemId === it.id);
              const left = Number(it.qtyOnHand) - (inCart ? toQty(inCart.qty) : 0);
              return (
                <button key={it.id} type="button" className={`item-tile${inCart ? ' on' : ''}`} onClick={() => add(it)}>
                  <span className="strong small">{it.description}</span>
                  <span className="xs muted">{it.sku}</span>
                  <span className="spread">
                    <Money cents={shelfPriceCents(it, vatRate)} />
                    {it.stocked && <span className={`chip ${left <= 0 ? 'warn' : ''}`}>{qtyText(left)} left</span>}
                  </span>
                  {inCart && <span className="xs strong">× {inCart.qty}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="panel">
            <Empty title={items.data?.length ? 'Nothing matches' : 'No items yet'}>
              {items.data?.length ? 'Try another word, or sell it as something not on the list.' : 'Add what you sell under Items, or sell it as something not on the list.'}
            </Empty>
          </div>
        )}
        <div className="row wrap">
          <button type="button" className="btn small" onClick={addFree}>
            <Icon name="plus" size={16} />
            Something not on the list
          </button>
          <button type="button" className="btn small quiet" onClick={() => setAdding(true)}>
            New item
          </button>
        </div>
      </section>

      {cart.length > 0 && (
        // On a phone the sale is below the list: its total stays in reach while picking.
        <button type="button" className="till-bar btn primary big" onClick={() => document.getElementById('this-sale')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          {cart.length} line{cart.length === 1 ? '' : 's'} · To pay <Money cents={totals.totalCents} />
        </button>
      )}
      <form id="this-sale" className="panel panel-pad stack cart" onSubmit={sell} aria-label="This sale">
        <div className="spread">
          <h2 className="small strong">This sale</h2>
          {cart.length > 0 && (
            <button type="button" className="btn quiet small" onClick={() => setCart([])}>
              Clear
            </button>
          )}
        </div>
        {done && (
          <div className="banner ok stack-sm" role="status">
            <strong>
              {done.kind === 'invoice' ? `Invoice ${done.number}` : `Sale ${done.saleNumber}`}: <Money cents={done.totalCents} /> paid
            </strong>
            {done.change != null && (
              <span>
                Change: <Money cents={done.change} />
              </span>
            )}
            <div className="row wrap">
              <button type="button" className="btn small" onClick={() => setPreview({ id: done.id, title: done.kind === 'invoice' ? `Invoice ${done.number}` : `Sale ${done.saleNumber}` })}>
                <Icon name="print" size={16} />
                {done.kind === 'invoice' ? 'Invoice' : 'Slip'}
              </button>
              <button type="button" className="btn small" onClick={() => onSold(done.id)}>
                {done.kind === 'sale' ? 'Make it an invoice or refund' : 'Refund'}
              </button>
            </div>
          </div>
        )}
        {cart.length === 0 ? (
          <p className="small muted">Tap an item to add it. Tap again for another.</p>
        ) : (
          <ul className="list cart-lines">
            {cart.map((l) => {
              const short = l.stocked && l.onHand != null && toQty(l.qty) > l.onHand;
              return (
                <li key={l.key} className="stack-sm cart-line">
                  {l.itemId ? (
                    <strong className="small">{l.description}</strong>
                  ) : (
                    <input className="input" value={l.description} onChange={(e) => upd(l.key, { description: e.target.value })} placeholder="What was sold" aria-label="What was sold" required />
                  )}
                  <div className="row wrap cart-nums">
                    <label className="row" style={{ gap: 4 }}>
                      <span className="xs muted">Qty</span>
                      <input className="input input-sm" inputMode="decimal" value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} aria-label={`How many ${l.description || 'of this'}`} style={{ width: 64 }} />
                    </label>
                    <label className="row" style={{ gap: 4 }}>
                      <span className="xs muted">@</span>
                      <MoneyInput value={l.unitPriceCents} onChange={(c) => upd(l.key, { unitPriceCents: c })} aria-label="Price each" allowNegative={!l.itemId} />
                    </label>
                    {vatRate > 0 && (
                      <select className="select small-select" value={l.vatCode} onChange={(e) => upd(l.key, { vatCode: e.target.value as SaleVatCode })} aria-label="VAT on this item">
                        {SALE_VAT_CODES.map((c) => (
                          <option key={c} value={c}>
                            {c === 'standard' ? `${vatRate / 100}% VAT` : SALE_VAT[c].short}
                          </option>
                        ))}
                      </select>
                    )}
                    <span className="grow" />
                    <Money cents={Math.round(toQty(l.qty) * (l.unitPriceCents ?? 0))} />
                    <button type="button" className="btn quiet small" onClick={() => drop(l.key)} aria-label={`Take ${l.description || 'this line'} off the sale`}>
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                  {short && <span className="xs warn-text">Only {qtyText(l.onHand ?? 0)} in stock: it goes to {qtyText((l.onHand ?? 0) - toQty(l.qty))} until stock comes in or it’s counted.</span>}
                </li>
              );
            })}
          </ul>
        )}

        {cart.length > 0 && (
          <>
            <dl className="totals">
              {vatRate > 0 && (
                <>
                  <div className="spread">
                    <dt className="small muted">Excluding VAT</dt>
                    <dd>
                      <Money cents={totals.subtotalCents} />
                    </dd>
                  </div>
                  <div className="spread">
                    <dt className="small muted">VAT</dt>
                    <dd>
                      <Money cents={totals.vatCents} />
                    </dd>
                  </div>
                </>
              )}
              <div className="spread">
                <dt className="strong">To pay</dt>
                <dd className="strong big-number">
                  <Money cents={totals.totalCents} />
                </dd>
              </div>
            </dl>
            {!settings.vatRegistered && <p className="xs muted">Not registered for VAT: no VAT on the sale.</p>}

            <Segmented label="Paid with" value={method} onChange={pickMethod} options={PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))} />
            <div className="form-grid">
              <Field label="Into">
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
              {method === 'cash' ? (
                <Field label="Cash given (for the change)">{(p) => <MoneyInput {...p} value={tendered} onChange={setTendered} />}</Field>
              ) : (
                <Field label="Reference (optional)">{(p) => <input {...p} className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. card slip no." />}</Field>
              )}
            </div>
            {method === 'cash' && tendered != null && tendered >= totals.totalCents && (
              <p className="small strong">
                Change: <Money cents={tendered - totals.totalCents} />
              </p>
            )}

            {vatRate > 0 && fullInvoice ? (
              <div className="banner signal small">{exported ? 'An export needs a full tax invoice with the buyer’s name and address.' : `Over ${formatZar(FULL_TAX_INVOICE_CENTS, { cents: false })} SARS wants a full tax invoice with the buyer’s name and address.`} Choose the customer:</div>
            ) : (
              <label className="check">
                <input type="checkbox" checked={asInvoice} onChange={(e) => setAsInvoice(e.target.checked)} />
                <span>A tax invoice for a customer (it can also be done afterwards)</span>
              </label>
            )}
            {needsClient ? (
              <ClientPick value={clientId} onChange={setClientId} />
            ) : (
              <Field label="Customer’s name (optional)" hint="On the slip. Leave it for a walk-in.">
                {(p) => <input {...p} className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />}
              </Field>
            )}
            <details>
              <summary className="small muted">Date: {formatDate(date)}</summary>
              <Field label="Sold on">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} max={todayIso()} required />}</Field>
            </details>
          </>
        )}
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block" disabled={busy || cart.length === 0}>
          <Icon name="check" size={18} />
          {busy ? 'Saving…' : <>Paid: <Money cents={totals.totalCents} /></>}
        </button>
      </form>
      {adding && (
        <ItemDrawer
          item={null}
          onClose={() => setAdding(false)}
          onSaved={(it) => {
            void items.reload();
            if (it) add(it);
          }}
        />
      )}
      {preview && <SlipPreview {...preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** A slip, invoice or credit note on screen, to share with the customer (WhatsApp, email) or print. */
function SlipPreview({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const toast = useToast();
  const share = async () => {
    try {
      const how = await sharePdf(`/api/documents/${id}/pdf`, title, `${title}: thank you for your business.`);
      if (how === 'downloaded') toast('PDF saved');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t share it', 'error');
    }
  };
  return (
    <PdfPreview
      title={title}
      load={async () => (await apiBlob(`/api/documents/${id}/pdf`)).blob}
      onClose={onClose}
      actions={
        <button type="button" className="btn primary small" onClick={() => void share()}>
          <Icon name="share" size={16} />
          Share
        </button>
      }
    />
  );
}

/** A customer from the client list, or a new one (name and address, for a full tax invoice). */
export function ClientPick({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const clients = useApi<ClientRow[]>('/api/clients');
  const [adding, setAdding] = useState(false);
  const [c, setC] = useState({ name: '', address: '', vatNumber: '', email: '' });
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    try {
      const row = await api<{ id: string }>('/api/clients', { body: { name: c.name, address: c.address, vatNumber: c.vatNumber, email: c.email } });
      await clients.reload();
      onChange(row.id);
      setAdding(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t add the client');
    }
  };
  if (adding)
    return (
      <div className="fieldset stack">
        <Field label="Customer’s name">{(p) => <input {...p} className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} autoFocus />}</Field>
        <Field label="Address" hint="On a full tax invoice">
          {(p) => <textarea {...p} className="textarea" rows={2} value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} />}
        </Field>
        <div className="form-grid">
          <Field label="Their VAT number (if they have one)">{(p) => <input {...p} className="input" value={c.vatNumber} onChange={(e) => setC({ ...c, vatNumber: e.target.value })} />}</Field>
          <Field label="Email (optional)">{(p) => <input {...p} className="input" type="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} />}</Field>
        </div>
        {error && <div className="banner alert small">{error}</div>}
        <div className="row">
          <button type="button" className="btn quiet small" onClick={() => setAdding(false)}>
            Cancel
          </button>
          <button type="button" className="btn small primary" onClick={() => void save()} disabled={!c.name.trim()}>
            Add the client
          </button>
        </div>
      </div>
    );
  return (
    <Field label="Customer">
      {(p) => (
        <div className="row">
          <select {...p} className="select grow" value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose…</option>
            {(clients.data ?? [])
              .filter((x) => x.active || x.id === value)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
          <button type="button" className="btn small" onClick={() => setAdding(true)}>
            New
          </button>
        </div>
      )}
    </Field>
  );
}

/* ------------------------------------------------------------------ the sales */

function SalesList({ onOpen }: { onOpen: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = new URLSearchParams({ ...(search.trim() ? { search: search.trim() } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const { data, error, loading, reload } = useApi<SaleRow[]>(`/api/sales${qs ? `?${qs}` : ''}`);
  const total = (data ?? []).reduce((t, r) => t + Number(r.totalCents) - Number(r.refundedCents), 0);
  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={18} />
          <input className="input" placeholder="Sale no., customer or item" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search sales" />
        </div>
        <label className="row small muted" style={{ gap: 6 }}>
          From
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} />
        </label>
        <label className="row small muted" style={{ gap: 6 }}>
          to
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} />
        </label>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.length ? (
        <>
          <p className="small muted">
            {data.length} sale{data.length === 1 ? '' : 's'}, <Money cents={total} /> after refunds
          </p>
          <div className="panel table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sale</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Paid</th>
                  <th className="num">Total</th>
                  <th className="num">Refunded</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                    <td>
                      <button type="button" className="link-btn" onClick={() => onOpen(r.id)}>
                        {r.saleNumber}
                      </button>
                      {r.kind === 'invoice' && <div className="xs muted">Invoice {r.number}</div>}
                    </td>
                    <td className="nowrap">{formatDate(r.issueDate)}</td>
                    <td>{r.clientName ?? (r.customerName || <span className="muted">Walk-in</span>)}</td>
                    <td className="small">
                      {r.method ? PAYMENT_METHOD_LABELS[r.method] : ''}
                      {r.sourceName ? <span className="muted"> · {r.sourceName}</span> : null}
                    </td>
                    <td className="num">
                      <Money cents={r.totalCents} />
                    </td>
                    <td className="num">{Number(r.refundedCents) ? <Money cents={r.refundedCents} /> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="panel">
          <Empty title="No sales yet">Sales made under Sell show here, with their slips, invoices and refunds.</Empty>
        </div>
      )}
    </div>
  );
}

/** One sale: what was sold, how it was paid, its refunds; make it an invoice, or refund it. */
export function SaleDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged?: () => void }) {
  const { isOwner } = useAuthed();
  const { data, error, loading, reload } = useApi<SaleDetail>(`/api/sales/${id}`, { fresh: true });
  const [mode, setMode] = useState<'view' | 'invoice' | 'refund'>('view');
  const [preview, setPreview] = useState<{ id: string; title: string } | null>(null);
  const changed = async () => {
    setMode('view');
    await reload();
    onChanged?.();
  };
  const d = data?.doc;
  const left = (data?.lines ?? []).filter((l) => Number(l.qty) - Number(l.creditedQty) > 0);
  const title = d ? (d.kind === 'invoice' ? `Invoice ${d.number}${d.saleNumber ? ` (sale ${d.saleNumber})` : ''}` : `Sale ${d.saleNumber}`) : 'Sale';
  return (
    <Drawer title={title} sub={d ? `${formatDate(d.issueDate, 'long')} · ${d.clientName ?? (d.customerName || 'Walk-in')}` : undefined} onClose={onClose} wide>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data && d ? (
        <div className="stack">
          {mode === 'invoice' && <MakeInvoice id={id} onCancel={() => setMode('view')} onDone={changed} />}
          {mode === 'refund' && <RefundForm sale={data} onCancel={() => setMode('view')} onDone={changed} />}
          {mode === 'view' && (
            <>
              <div className="row wrap">
                <button type="button" className="btn small" onClick={() => setPreview({ id: d.id, title })}>
                  <Icon name="print" size={16} />
                  {d.kind === 'invoice' ? 'Invoice PDF' : 'Slip'}
                </button>
                {isOwner && d.kind === 'sale' && (
                  <button type="button" className="btn small" onClick={() => setMode('invoice')}>
                    Make it an invoice
                  </button>
                )}
                {isOwner && left.length > 0 && (
                  <button type="button" className="btn small" onClick={() => setMode('refund')}>
                    {d.kind === 'invoice' && !d.saleNumber ? 'Goods returned' : 'Refund'}
                  </button>
                )}
                {d.kind === 'invoice' && d.saleNumber && (
                  <Link className="btn small quiet" to={`/documents/${d.id}`}>
                    Open the invoice
                  </Link>
                )}
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Qty</th>
                      <th className="num">Price{d.vatRateBp > 0 ? (d.pricesIncludeVat ? ' incl. VAT' : ' excl. VAT') : ''}</th>
                      {d.vatRateBp > 0 && <th>VAT</th>}
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {l.description}
                          {Number(l.creditedQty) > 0 && <div className="xs warn-text">{qtyText(l.creditedQty)} refunded</div>}
                        </td>
                        <td className="num">{qtyText(l.qty)}</td>
                        <td className="num">
                          <Money cents={l.unitPriceCents} />
                        </td>
                        {d.vatRateBp > 0 && <td className="small">{l.vatCode === 'standard' ? `${d.vatRateBp / 100}%` : SALE_VAT[l.vatCode].short}</td>}
                        <td className="num">
                          <Money cents={Math.round(Number(l.qty) * Number(l.unitPriceCents))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tbody>
                    {d.vatRateBp > 0 && (
                      <>
                        <tr>
                          <td colSpan={d.vatRateBp > 0 ? 4 : 3} className="num muted">
                            Excluding VAT
                          </td>
                          <td className="num">
                            <Money cents={d.subtotalCents} />
                          </td>
                        </tr>
                        <tr>
                          <td colSpan={4} className="num muted">
                            VAT
                          </td>
                          <td className="num">
                            <Money cents={d.vatCents} />
                          </td>
                        </tr>
                      </>
                    )}
                    <tr className="total">
                      <td colSpan={d.vatRateBp > 0 ? 4 : 3} className="num">
                        Total
                      </td>
                      <td className="num">
                        <Money cents={d.totalCents} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="stack-sm">
                <h3 className="small strong">Paid</h3>
                {data.receipts.map((r) => (
                  <div key={r.id} className="small">
                    {formatDate(r.date)}: <Money cents={r.amountCents} /> {PAYMENT_METHOD_LABELS[r.method]} into {r.sourceName}
                    {r.reference ? ` (${r.reference})` : ''}
                  </div>
                ))}
              </div>
              {data.refunds.length > 0 && (
                <div className="stack-sm">
                  <h3 className="small strong">Refunds</h3>
                  {data.refunds.map((r) => (
                    <div key={r.id} className="small">
                      {formatDate(r.date)}: <Money cents={r.amountCents} /> {PAYMENT_METHOD_LABELS[r.method]} from {r.sourceName} ·{' '}
                      <button type="button" className="link-btn" onClick={() => setPreview({ id: r.creditNoteId, title: `Credit note ${r.creditNoteNumber}` })}>
                        credit note {r.creditNoteNumber}
                      </button>
                      <div className="xs muted">{r.creditReason}</div>
                    </div>
                  ))}
                </div>
              )}
              {data.stock.length > 0 && (
                <div className="stack-sm">
                  <h3 className="small strong">Stock</h3>
                  {data.stock.map((m) => (
                    <div key={m.id} className="xs muted">
                      {m.description}: {Number(m.qty) > 0 ? '+' : ''}
                      {qtyText(m.qty)} at <Money cents={Math.abs(Number(m.valueCents))} /> cost
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      ) : null}
      {preview && <SlipPreview {...preview} onClose={() => setPreview(null)} />}
    </Drawer>
  );
}

function MakeInvoice({ id, onCancel, onDone }: { id: string; onCancel: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ doc: { number: string } }>(`/api/sales/${id}/invoice`, { body: { clientId } });
      toast(`Now invoice ${r.doc.number}`);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t make the invoice');
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <p className="small muted">The sale becomes a tax invoice with the customer’s details on it: every item, price and VAT class stays as it was sold, and it stays paid.</p>
      <ClientPick value={clientId} onChange={setClientId} />
      {error && <div className="banner alert small">{error}</div>}
      <div className="row">
        <button type="button" className="btn quiet" onClick={onCancel}>
          Back
        </button>
        <button className="btn primary grow" disabled={!clientId}>
          Make it an invoice
        </button>
      </div>
    </form>
  );
}

function RefundForm({ sale, onCancel, onDone }: { sale: SaleDetail; onCancel: () => void; onDone: () => Promise<void> }) {
  const { ref } = useAuthed();
  const toast = useToast();
  const paidWith = sale.receipts.find((r) => r.method !== ('credit' as PaymentMethod))?.method ?? 'cash';
  // An invoice still owed: what comes back can be taken off what's owed instead of paid out.
  const owing = sale.doc.kind === 'invoice' ? Number(sale.doc.totalCents) - Number(sale.doc.paidCents ?? 0) - Number(sale.doc.writtenOffCents ?? 0) : 0;
  const [money, setMoney] = useState<'paid_out' | 'off_owing'>(owing > 0 ? 'off_owing' : 'paid_out');
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState<PaymentMethod>(paidWith);
  const [sourceId, setSourceId] = useState(() => sourceFor(paidWith, ref.sources));
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [back, setBack] = useState<Record<string, { qty: string; restock: boolean }>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = sale.lines.filter((l) => Number(l.qty) - Number(l.creditedQty) > 0);
  const chosen = lines.filter((l) => toQty(back[l.id]?.qty ?? '') > 0);
  // What it comes to, the way the credit note will add it up (the server has the last word).
  const amount = useMemo(
    () => documentTotals(chosen.map((l) => ({ qty: toQty(back[l.id]!.qty), unitPriceCents: Number(l.unitPriceCents), vatCode: l.vatCode })), sale.doc.vatRateBp, sale.doc.pricesIncludeVat).totalCents,
    [chosen, back, sale.doc],
  );
  const set = (id: string, patch: Partial<{ qty: string; restock: boolean }>) => setBack((b) => ({ ...b, [id]: { qty: b[id]?.qty ?? '', restock: b[id]?.restock ?? true, ...patch } }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!chosen.length) return setError('Choose what’s coming back');
    setBusy(true);
    try {
      const r = await api<{ number: string; amountCents: number }>(`/api/documents/${sale.doc.id}/refund`, {
        body: { date, money, sourceId: money === 'paid_out' ? sourceId : null, method, reference, reason, lines: chosen.map((l) => ({ lineId: l.id, qty: toQty(back[l.id]!.qty), restock: back[l.id]!.restock })) },
      });
      toast(money === 'paid_out' ? `Refunded ${formatZar(r.amountCents)}: credit note ${r.number}` : `${formatZar(r.amountCents)} off what’s owed: credit note ${r.number}`);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t refund');
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <p className="small muted">A credit note for what comes back, at the price and VAT it was sold at, and the money paid back (or taken off what’s still owed). Goods in good order go back into stock.</p>
      <ul className="list panel">
        {lines.map((l) => {
          const can = Number(l.qty) - Number(l.creditedQty);
          const b = back[l.id];
          return (
            <li key={l.id} className="list-row">
              <div className="grow">
                <strong className="small">{l.description}</strong>
                <div className="xs muted">
                  {qtyText(can)} of {qtyText(l.qty)} can come back · <Money cents={l.unitPriceCents} /> each
                </div>
                {l.stocked && toQty(b?.qty ?? '') > 0 && (
                  <label className="check xs">
                    <input type="checkbox" checked={b?.restock ?? true} onChange={(e) => set(l.id, { restock: e.target.checked })} />
                    Back into stock (untick if it came back damaged)
                  </label>
                )}
              </div>
              <div className="row" style={{ gap: 4 }}>
                <input className="input input-sm" inputMode="decimal" value={b?.qty ?? ''} onChange={(e) => set(l.id, { qty: e.target.value })} placeholder="0" aria-label={`How many ${l.description} came back`} style={{ width: 64 }} />
                <button type="button" className="btn quiet small" onClick={() => set(l.id, { qty: qtyText(can) })}>
                  All
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <Field label="Why it came back" hint="Printed on the credit note">
        {(p) => <input {...p} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong size, returned unused" required />}
      </Field>
      {owing > 0 && (
        <Segmented
          label="The money"
          value={money}
          onChange={setMoney}
          options={[
            { value: 'off_owing', label: <>Off what’s owed (<Money cents={owing} />)</> },
            { value: 'paid_out', label: 'Paid back' },
          ]}
        />
      )}
      {money === 'paid_out' && <Segmented label="Paid back as" value={method} onChange={(m) => (setMethod(m), setSourceId(sourceFor(m, ref.sources)))} options={PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))} />}
      <div className="form-grid">
        {money === 'paid_out' && <Field label="Paid out of">
          {(p) => (
            <select {...p} className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {counterSources(ref.sources).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>}
        <Field label={money === 'paid_out' ? 'Refunded on' : 'Credited on'}>{(p) => <input {...p} className="input" type="date" value={date} min={sale.doc.issueDate} onChange={(e) => setDate(e.target.value)} required />}</Field>
      </div>
      {money === 'paid_out' && method !== 'cash' && <Field label="Reference (optional)">{(p) => <input {...p} className="input" value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>}
      {error && <div className="banner alert small">{error}</div>}
      <div className="row">
        <button type="button" className="btn quiet" onClick={onCancel}>
          Back
        </button>
        <button className="btn primary grow" disabled={busy || !chosen.length}>
          {money === 'paid_out' ? 'Refund' : 'Credit'} <Money cents={amount} />
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ the items */

function ItemList() {
  const { isOwner, has, settings } = useAuthed();
  const [search, setSearch] = useState('');
  const [state, setState] = useState<'1' | '0'>('1');
  const { data, error, loading, reload } = useApi<Item[]>(`/api/items?active=${state}`);
  const [edit, setEdit] = useState<Item | null | 'new'>(null);
  const needle = search.trim().toLowerCase();
  const rows = (data ?? []).filter((it) => !needle || it.description.toLowerCase().includes(needle) || it.sku.toLowerCase().includes(needle));
  const vatRate = settings.vatRegistered ? vatRateOn(todayIso()) : 0;
  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={18} />
          <input className="input" placeholder="Find an item or code" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find an item" />
        </div>
        <Segmented
          label="Which items"
          value={state}
          onChange={setState}
          options={[
            { value: '1', label: 'In use' },
            { value: '0', label: 'Not in use' },
          ]}
        />
        {isOwner && (
          <button className="btn primary small" onClick={() => setEdit('new')}>
            <Icon name="plus" size={16} />
            New item
          </button>
        )}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : rows.length ? (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Code</th>
                <th className="num">Price{vatRate > 0 ? ' (incl. VAT)' : ''}</th>
                {vatRate > 0 && <th>VAT</th>}
                {has('inventory') && <th className="num">In stock</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => (
                <tr key={it.id} className={isOwner ? 'clickable' : undefined} onClick={isOwner ? () => setEdit(it) : undefined}>
                  <td>
                    {it.description}
                    {it.unit && <span className="xs muted"> per {it.unit}</span>}
                  </td>
                  <td className="small muted">{it.sku}</td>
                  <td className="num">
                    <Money cents={shelfPriceCents(it, vatRate)} />
                  </td>
                  {vatRate > 0 && <td className="small">{it.vatCode === 'standard' ? `${vatRate / 100}%` : SALE_VAT[it.vatCode].short}</td>}
                  {has('inventory') && <td className={`num ${it.stocked && Number(it.qtyOnHand) < 0 ? 'warn-text' : ''}`}>{it.stocked ? qtyText(it.qtyOnHand) : <span className="muted">not stocked</span>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty title={data?.length ? 'Nothing matches' : 'No items yet'}>What you sell, with its price and VAT, so a sale is a tap.</Empty>
        </div>
      )}
      {edit && <ItemDrawer item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => void reload()} />}
    </div>
  );
}

/** Add or change an item: its name, code, price and VAT class, and (with Inventory on) whether its stock is kept. */
export function ItemDrawer({ item, onClose, onSaved }: { item: Item | null; onClose: () => void; onSaved: (it: Item | null) => void }) {
  const { settings, has } = useAuthed();
  const toast = useToast();
  const inventory = has('inventory');
  const [f, setF] = useState({
    description: item?.description ?? '',
    sku: item?.sku ?? '',
    category: (item?.category ?? 'goods') as LineCategory,
    unit: item?.unit ?? '',
    unitPriceCents: (item ? Number(item.unitPriceCents) : null) as number | null,
    priceIncludesVat: item?.priceIncludesVat ?? true,
    vatCode: (item?.vatCode ?? 'standard') as SaleVatCode,
    stocked: item?.stocked ?? inventory,
    reorderLevel: String(item?.reorderLevel ?? 0),
    active: item?.active ?? true,
  });
  const [error, setError] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const body = { ...f, unitPriceCents: f.unitPriceCents ?? 0, reorderLevel: toQty(f.reorderLevel), stocked: inventory ? f.stocked : (item?.stocked ?? false) };
      const saved = item ? await api<Item>(`/api/items/${item.id}`, { method: 'PUT', body }) : await api<Item>('/api/items', { body });
      toast('Saved');
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title={item ? item.description : 'New item'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">{(p) => <input {...p} className="input" value={f.description} onChange={(e) => set('description', e.target.value)} required autoFocus={!item} />}</Field>
        <div className="form-grid">
          <Field label="Code (optional)" hint="A barcode or your own code, to find it quickly">
            {(p) => <input {...p} className="input" value={f.sku} onChange={(e) => set('sku', e.target.value)} />}
          </Field>
          <Field label="Sold per (optional)">{(p) => <input {...p} className="input" value={f.unit} onChange={(e) => set('unit', e.target.value)} placeholder="e.g. each, kg, box" />}</Field>
        </div>
        <div className="form-grid">
          <Field label="Price">{(p) => <MoneyInput {...p} value={f.unitPriceCents} onChange={(c) => set('unitPriceCents', c)} />}</Field>
          {settings.vatRegistered && (
            <Field label="VAT">
              {(p) => (
                <select {...p} className="select" value={f.vatCode} onChange={(e) => set('vatCode', e.target.value as SaleVatCode)}>
                  {SALE_VAT_CODES.map((c) => (
                    <option key={c} value={c}>
                      {SALE_VAT[c].label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
        </div>
        {settings.vatRegistered && f.vatCode === 'standard' && (
          <Segmented
            label="The price"
            value={f.priceIncludesVat ? 'incl' : 'excl'}
            onChange={(v) => set('priceIncludesVat', v === 'incl')}
            options={[
              { value: 'incl', label: 'Includes VAT (as on the shelf)' },
              { value: 'excl', label: 'Excludes VAT' },
            ]}
          />
        )}
        <Field label="Shows on invoices as">
          {(p) => (
            <select {...p} className="select" value={f.category} onChange={(e) => set('category', e.target.value as LineCategory)}>
              {LINE_CATEGORIES.filter((c) => c !== 'demo' || f.category === 'demo').map((c) => (
                <option key={c} value={c}>
                  {lineLabel(settings.industry, c)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {inventory && (
          <div className="fieldset stack-sm">
            <label className="check">
              <input type="checkbox" checked={f.stocked} onChange={(e) => set('stocked', e.target.checked)} />
              <span>
                Keep stock of it
                <div className="xs muted">Bought in under Inventory, out when sold, counted at stock takes. Leave it off for a service.</div>
              </span>
            </label>
            {f.stocked && (
              <Field label="Reorder when down to" hint="Inventory flags it when stock falls to this">
                {(p) => <input {...p} className="input input-sm" inputMode="decimal" value={f.reorderLevel} onChange={(e) => set('reorderLevel', e.target.value)} style={{ maxWidth: 120 }} />}
              </Field>
            )}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
          In use (on the sales list)
        </label>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
      </form>
    </Drawer>
  );
}
