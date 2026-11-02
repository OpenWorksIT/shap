/**
 * Moving in from another package: choose the CSV exports, see what Shap found in them, map the
 * trial balance to Shap's accounts, then bring it all in at once.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatZar } from '@shap/shared';
import { PageHead } from '../components/Shell';
import { Field, Icon, Money, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuthed } from '../lib/session';

type Kind = 'invoices' | 'quotes' | 'clients' | 'items' | 'payments' | 'trialBalance' | 'costs' | 'unknown';
interface Preview {
  files: { name: string; kind: Kind; source: string; rows: number; skipped: { reason: string; count: number }[]; columns: string[] }[];
  clients: { total: number; new: number; matched: number };
  items: number;
  invoices: { count: number; drafts: number; totalCents: number; paidCents: number; from: string | null; to: string | null; already: string[]; totalsDiffer: { number: string; stated: number; worked: number }[]; withVat: number };
  quotes: number;
  payments: number;
  costs: { count: number; totalCents: number; unpaid: number };
  tb: { lines: { code: string; name: string; cents: number; suggestion: string | null }[]; balanced: boolean; differenceCents: number };
  openingDates: string[];
  accounts: { id: string; code: string; name: string; type: string }[];
  vatRegistered: boolean;
}
interface Result {
  clients: number;
  clientsMatched: number;
  items: number;
  invoices: number;
  quotes: number;
  payments: number;
  costs: number;
  opening: boolean;
  skipped: string[];
}

const KIND_LABELS: Record<Kind, string> = {
  invoices: 'Invoices',
  quotes: 'Quotes / estimates',
  clients: 'Clients / customers',
  items: 'Items / products',
  payments: 'Payments received',
  trialBalance: 'Trial balance (opening balances)',
  costs: 'Bills / expenses',
  unknown: 'Not recognised',
};

const HOW: { name: string; steps: string[] }[] = [
  { name: 'Xero', steps: ['Contacts → All contacts → Export (CSV)', 'Sales → Invoices → Export (CSV), and Quotes the same way', 'Products and services → Export', 'Purchases → Bills → Export, if you want bills too', 'Reports → Trial balance at your year end → Export to Excel, then save it as CSV'] },
  { name: 'QuickBooks Online', steps: ['Sales → Customers → Export', 'Reports → Transaction List by Date (or Invoice List) for the period → Export to Excel, then save as CSV', 'Sales → Products and services → Export', 'Reports → Trial balance at your year end → Export, save as CSV'] },
  { name: 'Sage Accounting', steps: ['Customers → Customers → Export', 'Customers → Customer invoices → Export', 'Items → Items → Export', 'Reports → Trial balance at your year end → Export to Excel, then save as CSV'] },
  { name: 'Zoho Invoice or Books', steps: ['Settings → Export data (or the ⋯ menu on each list): Customers, Invoices, Estimates, Items and Payments received, as CSV', 'Books: Reports → Trial balance at your year end → Export as CSV'] },
  { name: 'Invoice Ninja', steps: ['Settings → Import | Export → Export as CSV: Clients, Invoices, Quotes, Products and Payments'] },
];

export default function MoveInPage() {
  const { ref, settings, refreshReference } = useAuthed();
  const toast = useToast();
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tbAccounts, setTbAccounts] = useState<(string | null)[]>([]);
  const [openingDate, setOpeningDate] = useState('');
  const sources = ref.sources.filter((s) => s.active && !s.role);
  const [receiptSourceId, setReceiptSourceId] = useState(settings.defaultReceiptSourceId ?? sources[0]?.id ?? '');
  const [costSourceId, setCostSourceId] = useState(settings.defaultCostSourceId ?? sources[0]?.id ?? '');
  const [continueNumbering, setContinueNumbering] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const choose = async (list: FileList | null) => {
    if (!list?.length) return;
    setError('');
    setResult(null);
    const read = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text() })));
    const bad = read.filter((f) => /\.(xlsx?|ods|pdf)$/i.test(f.name));
    if (bad.length) setError(`${bad.map((f) => f.name).join(', ')}: open ${bad.length === 1 ? 'it' : 'them'} in a spreadsheet and save as CSV first.`);
    const next = [...files.filter((f) => !read.some((r) => r.name === f.name)), ...read.filter((f) => !bad.includes(f))];
    setFiles(next);
    if (next.length) await look(next);
  };
  const look = async (list: typeof files) => {
    setBusy(true);
    try {
      const p = await api<Preview>('/api/move-in/preview', { body: { files: list } });
      setPreview(p);
      setTbAccounts(p.tb.lines.map((l) => l.suggestion));
      setOpeningDate((d) => d || (p.tb.lines.length ? (p.openingDates[0] ?? '') : ''));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t read those files');
    } finally {
      setBusy(false);
    }
  };
  const remove = (name: string) => {
    const next = files.filter((f) => f.name !== name);
    setFiles(next);
    if (next.length) void look(next);
    else setPreview(null);
  };
  const go = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<Result>('/api/move-in', {
        body: { files, options: { receiptSourceId, costSourceId, openingDate: preview.tb.lines.length && openingDate ? openingDate : null, tbAccounts, continueNumbering, lockOpening: true } },
      });
      setResult(r);
      await refreshReference();
      toast('Moved in. Welcome to Shap!');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t bring that in');
    } finally {
      setBusy(false);
    }
  };

  const unmapped = tbAccounts.some((a) => !a);
  const nothing = preview && !preview.invoices.count && !preview.quotes && !preview.clients.total && !preview.items && !preview.costs.count && !preview.tb.lines.length;

  if (result)
    return (
      <div className="stack-lg narrow-wide">
        <PageHead title="Moved in" back={{ to: '/settings?tab=import', label: 'Settings' }} />
        <section className="panel panel-pad stack">
          <ul className="small steps-list">
            {result.invoices > 0 && <li>{result.invoices} invoices, with {result.payments} payments</li>}
            {result.quotes > 0 && <li>{result.quotes} quotes</li>}
            {(result.clients > 0 || result.clientsMatched > 0) && (
              <li>
                {result.clients} new clients{result.clientsMatched ? `, ${result.clientsMatched} already here updated` : ''}
              </li>
            )}
            {result.items > 0 && <li>{result.items} usual items, offered when you add a line</li>}
            {result.costs > 0 && <li>{result.costs} bills and expenses</li>}
            {result.opening && <li>Opening balances at {formatDate(openingDate)}, and the books closed up to then</li>}
          </ul>
          {result.skipped.length > 0 && (
            <details className="small">
              <summary>Left out ({result.skipped.length})</summary>
              <ul className="steps-list">
                {result.skipped.slice(0, 50).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="row wrap">
            <Link className="btn primary" to="/documents">
              See the invoices
            </Link>
            <Link className="btn" to="/accounts?tab=balance">
              Balance sheet
            </Link>
          </div>
          <p className="xs muted">Check a few invoices and the balance sheet against the old package before you cancel it. Keep its exports: SARS wants five years of records.</p>
        </section>
      </div>
    );

  return (
    <div className="stack-lg narrow-wide">
      <PageHead title="Move in from another package" back={{ to: '/settings?tab=import', label: 'Settings' }} sub="Sage, Xero, QuickBooks, Zoho or Invoice Ninja: bring your clients, invoices, what's been paid and your opening balances." />
      <section className="panel panel-pad stack">
        <h3>1. Export from the old package</h3>
        <p className="small">Export each list as CSV (a spreadsheet you can open in Excel). Bring whatever you have: clients and invoices are the main ones; the trial balance at your last year end sets the opening balances.</p>
        {HOW.map((h) => (
          <details key={h.name} className="small">
            <summary>{h.name}</summary>
            <ol className="steps-list" style={{ marginTop: 8 }}>
              {h.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </details>
        ))}
        <p className="xs muted">Menus move around between versions: if a step doesn’t match, look for Export on that list. Anything with names, numbers and amounts usually works.</p>
      </section>

      <section className="panel panel-pad stack">
        <h3>2. Choose the files</h3>
        <label className="btn primary" style={{ alignSelf: 'flex-start' }}>
          <Icon name="upload" size={18} />
          {files.length ? 'Add more files' : 'Choose CSV files'}
          <input type="file" accept=".csv,text/csv,text/plain" multiple hidden onChange={(e) => (void choose(e.target.files), (e.target.value = ''))} />
        </label>
        {busy && !preview && <p className="small muted">Reading…</p>}
        {preview && (
          <ul className="list">
            {preview.files.map((f) => (
              <li key={f.name} className="list-row">
                <span className="grow small">
                  <strong>{f.name}</strong>
                  <div className={`xs ${f.kind === 'unknown' ? 'warn-text' : 'muted'}`}>
                    {KIND_LABELS[f.kind]}
                    {f.kind !== 'unknown' ? ` from ${f.source} · ${f.rows} rows` : `: columns ${f.columns.join(', ')}`}
                    {f.skipped.map((s) => ` · ${s.count} left out: ${s.reason.toLowerCase()}`).join('')}
                  </div>
                </span>
                <button className="btn quiet small" onClick={() => remove(f.name)} aria-label={`Remove ${f.name}`}>
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {preview && !nothing && (
        <section className="panel panel-pad stack">
          <h3>3. Check what comes in</h3>
          <ul className="small steps-list">
            {preview.invoices.count > 0 && (
              <li>
                <strong>{preview.invoices.count} invoices</strong>
                {preview.invoices.from && ` from ${formatDate(preview.invoices.from)} to ${formatDate(preview.invoices.to!)}`}: <Money cents={preview.invoices.totalCents} /> invoiced, <Money cents={preview.invoices.paidCents} /> paid
                {preview.payments ? ` (${preview.payments} payments from the payments file)` : ''}
                {preview.invoices.drafts ? `, ${preview.invoices.drafts} drafts` : ''}
              </li>
            )}
            {preview.quotes > 0 && <li>{preview.quotes} quotes</li>}
            {preview.clients.total > 0 && (
              <li>
                {preview.clients.new} new clients{preview.clients.matched ? ` (${preview.clients.matched} already in Shap: their blank details get filled in)` : ''}
              </li>
            )}
            {preview.items > 0 && <li>{preview.items} items for the usual-items list</li>}
            {preview.costs.count > 0 && (
              <li>
                {preview.costs.count} bills and expenses (<Money cents={preview.costs.totalCents} />){preview.costs.unpaid ? `, ${preview.costs.unpaid} still to pay` : ''}
              </li>
            )}
          </ul>
          {preview.invoices.already.length > 0 && <div className="banner signal small">Already in Shap, so left out: {preview.invoices.already.join(', ')}.</div>}
          {preview.invoices.totalsDiffer.length > 0 && (
            <div className="banner signal small">
              Totals that don’t add up from the lines (check these after): {preview.invoices.totalsDiffer.map((t) => `${t.number} (file ${formatZar(t.stated)}, lines ${formatZar(t.worked)})`).join(', ')}.
            </div>
          )}
          {preview.invoices.withVat > 0 && !preview.vatRegistered && (
            <div className="banner signal small">{preview.invoices.withVat} invoices charge VAT but Shap isn’t set as registered for VAT: switch it on under Settings → Invoicing &amp; tax first.</div>
          )}
          {preview.payments + preview.invoices.count > 0 && (
            <Field label="Clients’ payments went into">
              {(p) => (
                <select {...p} className="select" value={receiptSourceId} onChange={(e) => setReceiptSourceId(e.target.value)}>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          {preview.costs.count > 0 && (
            <Field label="Paid bills and expenses came from">
              {(p) => (
                <select {...p} className="select" value={costSourceId} onChange={(e) => setCostSourceId(e.target.value)}>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          {preview.invoices.count + preview.quotes > 0 && (
            <label className="check small">
              <input type="checkbox" checked={continueNumbering} onChange={(e) => setContinueNumbering(e.target.checked)} />
              Carry on the old package’s numbering (the next invoice follows the last one imported)
            </label>
          )}
        </section>
      )}

      {preview && preview.tb.lines.length > 0 && (
        <section className="panel stack">
          <div className="panel-head">
            <strong>Opening balances</strong>
            <div className="xs muted">Each line of the trial balance goes to one of Shap’s accounts. Income and expenses close into retained earnings.</div>
          </div>
          <div className="panel-pad stack" style={{ paddingTop: 0 }}>
            <Field label="The trial balance is at" hint="The last day of your last financial year in the old package. The books are closed up to then.">
              {(p) => (
                <select {...p} className="select" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)}>
                  {preview.openingDates.map((d) => (
                    <option key={d} value={d}>
                      {formatDate(d)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {!preview.tb.balanced && <div className="banner alert small">Debits and credits are {formatZar(Math.abs(preview.tb.differenceCents))} apart: export the full trial balance again.</div>}
          </div>
          <ul className="list">
            {preview.tb.lines.map((l, i) => (
              <li key={i} className="list-row wrap">
                <span className="grow small" style={{ minWidth: 140 }}>
                  {l.code && <span className="muted">{l.code} </span>}
                  {l.name}
                  <div className="xs muted">
                    <Money cents={Math.abs(l.cents)} /> {l.cents > 0 ? 'debit' : 'credit'}
                  </div>
                </span>
                <select className={`select auto ${tbAccounts[i] ? '' : 'invalid'}`} value={tbAccounts[i] ?? ''} onChange={(e) => setTbAccounts(tbAccounts.map((a, j) => (j === i ? e.target.value || null : a)))} aria-label={`Shap account for ${l.name}`}>
                  <option value="">Choose…</option>
                  {preview.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <div className="banner alert small">{error}</div>}
      {preview && !nothing && (
        <button className="btn primary big block" disabled={busy || (preview.tb.lines.length > 0 && (unmapped || !preview.tb.balanced || !openingDate))} onClick={() => void go()}>
          {busy ? 'Bringing it in…' : 'Bring it all in'}
        </button>
      )}
      {nothing && <div className="banner signal small">Shap couldn’t find clients, invoices or balances in those files. Check they’re CSV exports of lists (not reports laid out for printing).</div>}
      <p className="xs muted">Everything goes in together, or nothing does. Back up first (Settings → Updates & backups) if your books already have work in them.</p>
    </div>
  );
}
