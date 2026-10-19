import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ACCOUNT_TYPE_LABELS,
  addMonths,
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  financialYear,
  formatAmount,
  formatDate,
  formatZar,
  LEDGER_SOURCE_LABELS,
  todayIso,
  type AssetCategory,
} from '@shap/shared';
import { PageHead } from '../components/Shell';
import { Drawer, Empty, ErrorBox, Field, Icon, Loading, Money, MoneyInput, Segmented, Tabs, useToast } from '../components/ui';
import { api, ApiError, apiUrl } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { Account, StatementLine, Totals } from '../lib/types';
import { BankRecon } from './Bank';
import { StatementFiles } from './StatementFiles';
import { ProvisionalTax, YearEnd } from './YearEnd';

type Tab = 'income' | 'balance' | 'trial' | 'ledger' | 'journals' | 'assets' | 'bank' | 'files' | 'checks' | 'yearend' | 'tax' | 'export';

export default function AccountsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'income';
  const go = (t: Tab, extra: Record<string, string> = {}) => setParams({ tab: t, ...extra }, { replace: false });
  return (
    <div className="stack-lg">
      <PageHead title="Accounts" sub="Built live from your invoices, costs, labour and payments." />
      <div className="tabs-scroll">
        <Tabs<Tab>
          value={tab}
          onChange={(t) => go(t)}
          tabs={[
            { value: 'income', label: 'Income statement' },
            { value: 'balance', label: 'Balance sheet' },
            { value: 'trial', label: 'Trial balance' },
            { value: 'ledger', label: 'Ledger' },
            { value: 'journals', label: 'Journals' },
            { value: 'assets', label: 'Assets' },
            { value: 'bank', label: 'Bank statements' },
            { value: 'files', label: 'Statement PDFs' },
            { value: 'checks', label: 'Balance checks' },
            { value: 'yearend', label: 'Year end' },
            { value: 'tax', label: 'Provisional tax' },
            { value: 'export', label: 'Export' },
          ]}
        />
      </div>
      {tab === 'income' && <IncomeStatement />}
      {tab === 'balance' && <BalanceSheet onAccount={(id) => go('ledger', { account: id })} />}
      {tab === 'trial' && <TrialBalance onAccount={(id) => go('ledger', { account: id })} />}
      {tab === 'ledger' && <Ledger />}
      {tab === 'journals' && <Journals />}
      {tab === 'assets' && <Assets />}
      {tab === 'bank' && <BankRecon />}
      {tab === 'files' && <StatementFiles />}
      {tab === 'checks' && <BalanceChecks />}
      {tab === 'yearend' && <YearEnd />}
      {tab === 'tax' && <ProvisionalTax />}
      {tab === 'export' && <Exports />}
    </div>
  );
}

/* ---------------------------------------------------------------- periods */
function usePeriods() {
  const { settings } = useAuthed();
  const today = todayIso();
  const fy = financialYear(today, settings.fyEndMonth);
  const fys = [0, 1, 2, 3].map((n) => financialYear(addMonths(fy.start, -12 * n), settings.fyEndMonth));
  return { today, fy, fys };
}

function PeriodPicker({ from, to, onChange }: { from: string; to: string; onChange: (f: string, t: string) => void }) {
  const { fys, today } = usePeriods();
  const preset = fys.find((f) => f.start === from && (f.end === to || (to === today && f.end >= today)));
  return (
    <div className="toolbar wrap">
      <select
        className="select auto"
        value={preset ? preset.label : 'custom'}
        onChange={(e) => {
          const f = fys.find((x) => x.label === e.target.value);
          if (f) onChange(f.start, f.end < today ? f.end : today);
        }}
        aria-label="Financial year"
      >
        {fys.map((f) => (
          <option key={f.label} value={f.label}>
            {f.label} ({formatDate(f.start)} – {formatDate(f.end)})
          </option>
        ))}
        <option value="custom">Custom dates</option>
      </select>
      <input className="input auto" type="date" value={from} onChange={(e) => onChange(e.target.value, to)} aria-label="From" />
      <span className="muted">to</span>
      <input className="input auto" type="date" value={to} onChange={(e) => onChange(from, e.target.value)} aria-label="To" />
    </div>
  );
}

/* ---------------------------------------------------------------- income statement */
interface IncomeStatementData {
  from: string;
  to: string;
  months: { key: string; label: string }[];
  income: StatementLine[];
  costOfSales: StatementLine[];
  expenses: StatementLine[];
  tax: StatementLine[];
  totals: Record<'income' | 'costOfSales' | 'grossProfit' | 'expenses' | 'profitBeforeTax' | 'tax' | 'netProfit', Totals>;
}

function IncomeStatement() {
  const { fy, today } = usePeriods();
  const [range, setRange] = useState({ from: fy.start, to: today });
  const [view, setView] = useState<'total' | 'month'>('total');
  const qs = `from=${range.from}&to=${range.to}${view === 'month' ? '&by=month' : ''}`;
  const { data, error } = useApi<IncomeStatementData>(`/api/reports/income-statement?${qs}`);
  const cols = view === 'month' ? (data?.months ?? []) : [];
  const amountCells = (t: Totals, strong = false) => (
    <>
      {cols.map((_, i) => (
        <td key={i} className={`num ${strong ? 'strong' : ''}`}>
          {fmt(t.months[i] ?? 0)}
        </td>
      ))}
      <td className={`num ${strong ? 'strong' : ''}`}>{fmt(t.totalCents)}</td>
    </>
  );
  const section = (title: string, lines: StatementLine[], total?: [string, Totals]) => (
    <tbody>
      <tr className="group">
        <th colSpan={cols.length + 2}>{title}</th>
      </tr>
      {lines.map((l) => (
        <tr key={l.id}>
          <td>
            <Link to={`/accounts?tab=ledger&account=${l.id}&from=${range.from}&to=${range.to}`} className="plain">
              <span className="code">{l.code}</span> {l.name}
            </Link>
          </td>
          {amountCells(l)}
        </tr>
      ))}
      {total && (
        <tr className="total">
          <td>{total[0]}</td>
          {amountCells(total[1], true)}
        </tr>
      )}
    </tbody>
  );
  return (
    <div className="stack">
      <div className="spread wrap">
        <PeriodPicker from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
        <div className="row">
          <Segmented<'total' | 'month'> label="View" value={view} onChange={setView} options={[{ value: 'total', label: 'Total' }, { value: 'month', label: 'By month' }]} />
          <a className="btn small" href={apiUrl(`/api/reports/income-statement?${qs}&format=csv`)}>
            <Icon name="download" size={16} />
            CSV
          </a>
        </div>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : (
        <section className="panel table-wrap">
          <table className={`table statement ${view === 'month' ? 'wide' : 'narrow-statement'}`}>
            <thead>
              <tr>
                <th />
                {cols.map((m) => (
                  <th key={m.key} className="num">
                    {m.label}
                  </th>
                ))}
                <th className="num">{view === 'month' ? 'Total' : `${formatDate(data.from)} – ${formatDate(data.to)}`}</th>
              </tr>
            </thead>
            {section('Income', data.income, ['Total income', data.totals.income])}
            {section('Cost of sales', data.costOfSales, ['Gross profit', data.totals.grossProfit])}
            {section('Running costs', data.expenses, ['Total running costs', data.totals.expenses])}
            <tbody>
              <tr className="total">
                <td>Profit before tax</td>
                {amountCells(data.totals.profitBeforeTax, true)}
              </tr>
              {data.tax.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  {amountCells(l)}
                </tr>
              ))}
              <tr className="grand">
                <td>Net profit</td>
                {amountCells(data.totals.netProfit, true)}
              </tr>
            </tbody>
          </table>
          <p className="xs muted panel-pad">
            Job costs count when the job is invoiced, so a month shows a job’s income and its costs together. Costs on jobs not yet invoiced sit in Work in
            progress on the balance sheet.
          </p>
        </section>
      )}
    </div>
  );
}
const fmt = (c: number) => (c === 0 ? '–' : formatAmount(c));

/* ---------------------------------------------------------------- balance sheet */
interface BsItem {
  id: string;
  code: string;
  name: string;
  amountCents: number;
}
interface BalanceSheetData {
  date: string;
  financialYear: { label: string };
  assets: { nonCurrent: BsItem[]; current: BsItem[]; totalCents: number };
  liabilities: { nonCurrent: BsItem[]; current: BsItem[]; totalCents: number };
  equity: { items: BsItem[]; totalCents: number };
  differenceCents: number;
}

function DatePicker({ date, onChange }: { date: string; onChange: (d: string) => void }) {
  const { fys, today } = usePeriods();
  return (
    <div className="toolbar wrap">
      <select className="select auto" value={fys.some((f) => f.end === date) ? date : date === today ? 'today' : 'custom'} onChange={(e) => onChange(e.target.value === 'today' ? today : e.target.value)} aria-label="As at">
        <option value="today">Today</option>
        {fys.filter((f) => f.end < today).map((f) => (
          <option key={f.end} value={f.end}>
            Year end {formatDate(f.end)} ({f.label})
          </option>
        ))}
        <option value="custom">Other date</option>
      </select>
      <input className="input auto" type="date" value={date} onChange={(e) => onChange(e.target.value)} aria-label="Date" />
    </div>
  );
}

function BalanceSheet({ onAccount }: { onAccount: (id: string) => void }) {
  const { today } = usePeriods();
  const [date, setDate] = useState(today);
  const { data, error } = useApi<BalanceSheetData>(`/api/reports/balance-sheet?date=${date}`);
  const rows = (items: BsItem[]) =>
    items.map((i) => (
      <tr key={i.id} className={i.code ? 'clickable' : ''} onClick={() => i.code && onAccount(i.id)}>
        <td>
          {i.code && <span className="code">{i.code}</span>} {i.name}
        </td>
        <td className="num">{fmt(i.amountCents)}</td>
      </tr>
    ));
  const sub = (label: string, cents: number) => (
    <tr className="total">
      <td>{label}</td>
      <td className="num strong">{fmt(cents)}</td>
    </tr>
  );
  return (
    <div className="stack">
      <div className="spread wrap">
        <DatePicker date={date} onChange={setDate} />
        <a className="btn small" href={apiUrl(`/api/reports/balance-sheet?date=${date}&format=csv`)}>
          <Icon name="download" size={16} />
          CSV
        </a>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : (
        <section className="panel table-wrap">
          <table className="table statement narrow-statement">
            <thead>
              <tr>
                <th>As at {formatDate(data.date, 'long')}</th>
                <th className="num">R</th>
              </tr>
            </thead>
            <tbody>
              <tr className="group">
                <th colSpan={2}>Assets</th>
              </tr>
              {data.assets.nonCurrent.length > 0 && (
                <>
                  <tr className="subgroup">
                    <td colSpan={2}>Non-current assets</td>
                  </tr>
                  {rows(data.assets.nonCurrent)}
                </>
              )}
              <tr className="subgroup">
                <td colSpan={2}>Current assets</td>
              </tr>
              {rows(data.assets.current)}
              {sub('Total assets', data.assets.totalCents)}
            </tbody>
            <tbody>
              <tr className="group">
                <th colSpan={2}>Liabilities</th>
              </tr>
              {data.liabilities.nonCurrent.length > 0 && (
                <>
                  <tr className="subgroup">
                    <td colSpan={2}>Non-current liabilities</td>
                  </tr>
                  {rows(data.liabilities.nonCurrent)}
                </>
              )}
              <tr className="subgroup">
                <td colSpan={2}>Current liabilities</td>
              </tr>
              {rows(data.liabilities.current)}
              {sub('Total liabilities', data.liabilities.totalCents)}
            </tbody>
            <tbody>
              <tr className="group">
                <th colSpan={2}>Equity</th>
              </tr>
              {rows(data.equity.items)}
              {sub('Total equity', data.equity.totalCents)}
              <tr className="grand">
                <td>Liabilities and equity</td>
                <td className="num strong">{fmt(data.liabilities.totalCents + data.equity.totalCents)}</td>
              </tr>
            </tbody>
          </table>
          {data.differenceCents !== 0 && <div className="banner alert">Out of balance by {formatZar(data.differenceCents)}. Please report this.</div>}
        </section>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- trial balance */
function TrialBalance({ onAccount }: { onAccount: (id: string) => void }) {
  const { today } = usePeriods();
  const [date, setDate] = useState(today);
  const { data, error } = useApi<{ date: string; financialYear: { label: string; start: string }; rows: { id: string; code: string; name: string; type: Account['type']; debitCents: number; creditCents: number }[]; totals: { debitCents: number; creditCents: number; differenceCents: number } }>(
    `/api/reports/trial-balance?date=${date}`,
  );
  return (
    <div className="stack">
      <div className="spread wrap">
        <DatePicker date={date} onChange={setDate} />
        <a className="btn small" href={apiUrl(`/api/reports/trial-balance?date=${date}&format=csv`)}>
          <Icon name="download" size={16} />
          CSV
        </a>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : (
        <section className="panel table-wrap">
          <table className="table statement">
            <thead>
              <tr>
                <th>Account</th>
                <th className="hide-sm">Type</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => onAccount(r.id)}>
                  <td>
                    <span className="code">{r.code}</span> {r.name}
                  </td>
                  <td className="hide-sm muted">{ACCOUNT_TYPE_LABELS[r.type]}</td>
                  <td className="num">{r.debitCents ? formatAmount(r.debitCents) : ''}</td>
                  <td className="num">{r.creditCents ? formatAmount(r.creditCents) : ''}</td>
                </tr>
              ))}
              <tr className="grand">
                <td>Total</td>
                <td className="hide-sm" />
                <td className="num strong">{formatAmount(data.totals.debitCents)}</td>
                <td className="num strong">{formatAmount(data.totals.creditCents)}</td>
              </tr>
            </tbody>
          </table>
          <p className="xs muted panel-pad">
            Income and expense accounts show {data.financialYear.label} from {formatDate(data.financialYear.start)}; earlier years’ profit is in retained earnings.
          </p>
        </section>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- ledger */
interface LedgerData {
  account: Account;
  from: string;
  to: string;
  openingCents: number;
  closingCents: number;
  rows: { date: string; amountCents: number; source: string; sourceId: string; memo: string; projectId: string | null; projectName: string | null; balanceCents: number }[];
}

function sourceLink(source: string, id: string): string | null {
  if (source === 'invoice' || source === 'write_off') return `/documents/${id}`;
  if (source === 'journal') return `/accounts?tab=journals&journal=${id}`;
  if (source === 'asset' || source === 'depreciation' || source === 'disposal') return '/accounts?tab=assets';
  return null;
}

function Ledger() {
  const { ref } = useAuthed();
  const { fy, today } = usePeriods();
  const [params, setParams] = useSearchParams();
  const account = params.get('account') ?? ref.accounts.find((a) => a.systemKey === 'bank')?.id ?? '';
  const from = params.get('from') ?? fy.start;
  const to = params.get('to') ?? today;
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    n.set('tab', 'ledger');
    n.set(k, v);
    setParams(n, { replace: true });
  };
  const qs = `account=${account}&from=${from}&to=${to}`;
  const { data, error } = useApi<LedgerData>(account ? `/api/reports/ledger?${qs}` : null);
  return (
    <div className="stack">
      <div className="toolbar wrap">
        <select className="select auto" value={account} onChange={(e) => set('account', e.target.value)} aria-label="Account">
          {ref.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
        <PeriodPicker from={from} to={to} onChange={(f, t) => {
          const n = new URLSearchParams(params);
          n.set('tab', 'ledger');
          n.set('from', f);
          n.set('to', t);
          setParams(n, { replace: true });
        }} />
        <a className="btn small" href={apiUrl(`/api/reports/ledger?${qs}&format=csv`)}>
          <Icon name="download" size={16} />
          CSV
        </a>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : (
        <section className="panel table-wrap">
          <table className="table statement">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="subgroup">
                <td>{formatDate(data.from)}</td>
                <td>Opening balance</td>
                <td />
                <td />
                <td className="num">{formatAmount(data.openingCents)}</td>
              </tr>
              {data.rows.map((r, i) => {
                const link = sourceLink(r.source, r.sourceId);
                return (
                  <tr key={i}>
                    <td className="nowrap">{formatDate(r.date)}</td>
                    <td>
                      {link ? (
                        <Link to={link} className="plain">
                          {r.memo}
                        </Link>
                      ) : (
                        r.memo
                      )}
                      <div className="xs muted">
                        {LEDGER_SOURCE_LABELS[r.source] ?? r.source}
                        {r.projectId && (
                          <>
                            {' · '}
                            <Link to={`/jobs/${r.projectId}`}>{r.projectName}</Link>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="num">{r.amountCents > 0 ? formatAmount(r.amountCents) : ''}</td>
                    <td className="num">{r.amountCents < 0 ? formatAmount(-r.amountCents) : ''}</td>
                    <td className="num">{formatAmount(r.balanceCents)}</td>
                  </tr>
                );
              })}
              <tr className="grand">
                <td>{formatDate(data.to)}</td>
                <td>Closing balance</td>
                <td />
                <td />
                <td className="num strong">{formatAmount(data.closingCents)}</td>
              </tr>
            </tbody>
          </table>
          <p className="xs muted panel-pad">Debits are positive and credits negative, so a loan or money owed shows in brackets.</p>
        </section>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- journals */
interface JournalRow {
  id: string;
  date: string;
  description: string;
  reference: string;
  kind: string;
  totalCents: number;
  lineCount: number;
}
interface JournalLine {
  accountId: string;
  debitCents: number | null;
  creditCents: number | null;
  memo: string;
}

function Journals() {
  const { isOwner } = useAuthed();
  const [params] = useSearchParams();
  const { data, error, reload } = useApi<JournalRow[]>('/api/journals');
  const [open, setOpen] = useState<string | 'new' | null>(params.get('journal'));
  return (
    <div className="stack">
      <div className="spread wrap">
        <p className="small muted grow">For what isn’t a cost, invoice or wage: money you put into the company, loan repayments, tax, depreciation adjustments, opening balances.</p>
        {isOwner && (
          <button className="btn primary" onClick={() => setOpen('new')}>
            <Icon name="plus" size={18} />
            New journal
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : data.length ? (
        <section className="panel">
          <ul className="list">
            {data.map((j) => (
              <li key={j.id}>
                <button className="list-row" onClick={() => setOpen(j.id)}>
                  <span className="nowrap small">{formatDate(j.date)}</span>
                  <span className="grow">
                    {j.description}
                    <div className="xs muted">
                      {j.kind === 'import' ? 'From the tracker import' : j.kind === 'adjustment' ? 'Balance check adjustment' : 'Journal'}
                      {j.reference ? ` · ${j.reference}` : ''}
                    </div>
                  </span>
                  <Money cents={j.totalCents} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="panel">
          <Empty title="No journals yet" />
        </div>
      )}
      {open && <JournalDrawer id={open === 'new' ? null : open} onClose={() => setOpen(null)} onSaved={reload} />}
    </div>
  );
}

function JournalDrawer({ id, onClose, onSaved }: { id: string | null; onClose: () => void; onSaved: () => void }) {
  const { ref, isOwner } = useAuthed();
  const toast = useToast();
  const existing = useApi<{ journal: JournalRow; lines: (JournalLine & { code: string; name: string })[] }>(id ? `/api/journals/${id}` : null);
  const [f, setF] = useState<{ date: string; description: string; reference: string; lines: JournalLine[] } | null>(id ? null : { date: todayIso(), description: '', reference: '', lines: [blankLine(), blankLine()] });
  const [error, setError] = useState('');
  if (id && existing.data && !f) {
    setF({ date: existing.data.journal.date, description: existing.data.journal.description, reference: existing.data.journal.reference, lines: existing.data.lines.map((l) => ({ accountId: l.accountId, debitCents: l.debitCents || null, creditCents: l.creditCents || null, memo: l.memo })) });
  }
  const debit = (f?.lines ?? []).reduce((s, l) => s + (l.debitCents ?? 0), 0);
  const credit = (f?.lines ?? []).reduce((s, l) => s + (l.creditCents ?? 0), 0);
  const setLine = (i: number, patch: Partial<JournalLine>) => setF((x) => x && { ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f) return;
    const body = { ...f, lines: f.lines.filter((l) => l.accountId && (l.debitCents || l.creditCents)).map((l) => ({ ...l, debitCents: l.debitCents ?? 0, creditCents: l.creditCents ?? 0 })) };
    try {
      if (id) await api(`/api/journals/${id}`, { method: 'PUT', body });
      else await api('/api/journals', { body });
      toast('Journal saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  const del = async () => {
    if (!id || !confirm('Delete this journal?')) return;
    try {
      await api(`/api/journals/${id}`, { method: 'DELETE' });
      toast('Journal deleted');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t delete');
    }
  };
  return (
    <Drawer title={id ? 'Journal' : 'New journal'} onClose={onClose} wide>
      {!f ? (
        <Loading />
      ) : (
        <form className="stack" onSubmit={submit}>
          <div className="form-grid">
            <Field label="Date">{(p) => <input {...p} className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} disabled={!isOwner} />}</Field>
            <Field label="Reference">{(p) => <input {...p} className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} disabled={!isOwner} />}</Field>
          </div>
          <Field label="What it’s for">{(p) => <input {...p} className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Company repaid part of my loan" required disabled={!isOwner} />}</Field>
          <div className="journal-lines">
            <div className="journal-line head">
              <span>Account</span>
              <span className="num">Debit</span>
              <span className="num">Credit</span>
            </div>
            {f.lines.map((l, i) => (
              <div key={i} className="journal-line">
                <select className="select" value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })} aria-label="Account" disabled={!isOwner}>
                  <option value="">Choose…</option>
                  {ref.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
                <MoneyInput value={l.debitCents} onChange={(c) => setLine(i, { debitCents: c, creditCents: c ? null : l.creditCents })} />
                <MoneyInput value={l.creditCents} onChange={(c) => setLine(i, { creditCents: c, debitCents: c ? null : l.debitCents })} />
              </div>
            ))}
            <div className="journal-line head">
              <span>{debit === credit ? 'Balanced' : `Out by ${formatZar(Math.abs(debit - credit))}`}</span>
              <span className="num">{formatAmount(debit)}</span>
              <span className="num">{formatAmount(credit)}</span>
            </div>
          </div>
          {isOwner && (
            <button type="button" className="btn small" onClick={() => setF({ ...f, lines: [...f.lines, blankLine()] })}>
              <Icon name="plus" size={14} />
              Line
            </button>
          )}
          <p className="xs muted">Debit what increases (bank, costs) or decreases a loan; credit the other side. Example: the company repays you R5 000 from the bank → debit Owner’s loan, credit Bank.</p>
          {error && <div className="banner alert small">{error}</div>}
          {isOwner && (
            <div className="row">
              <button className="btn primary" disabled={debit !== credit || !debit}>
                Save journal
              </button>
              {id && (
                <button type="button" className="btn danger" onClick={() => void del()}>
                  Delete
                </button>
              )}
            </div>
          )}
        </form>
      )}
    </Drawer>
  );
}
const blankLine = (): JournalLine => ({ accountId: '', debitCents: null, creditCents: null, memo: '' });

/* ---------------------------------------------------------------- assets */
interface AssetRow {
  id: string;
  name: string;
  category: AssetCategory;
  purchaseDate: string;
  costCents: number;
  costId: string | null;
  sourceId: string | null;
  sourceName: string | null;
  lifeMonths: number;
  residualCents: number;
  disposedOn: string | null;
  disposalProceedsCents: number;
  disposalSourceId: string | null;
  notes: string;
  accumulatedCents: number;
  depreciationThisYearCents: number;
}

function Assets() {
  const { isOwner } = useAuthed();
  const { data, error, reload } = useApi<AssetRow[]>('/api/assets');
  const [open, setOpen] = useState<AssetRow | 'new' | null>(null);
  const totals = (data ?? []).filter((a) => !a.disposedOn).reduce((t, a) => ({ cost: t.cost + a.costCents, acc: t.acc + a.accumulatedCents }), { cost: 0, acc: 0 });
  return (
    <div className="stack">
      <div className="spread wrap">
        <p className="small muted grow">Tools, equipment and vehicles that last years. Each is written off (depreciated) a month at a time over its life. Small tools stay as running costs.</p>
        {isOwner && (
          <button className="btn primary" onClick={() => setOpen('new')}>
            <Icon name="plus" size={18} />
            Add asset
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : data.length ? (
        <section className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th className="hide-sm">Bought</th>
                <th className="num">Cost</th>
                <th className="num hide-sm">Written off</th>
                <th className="num">Book value</th>
                <th className="num hide-md">This year</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id} className={`clickable ${a.disposedOn ? 'inactive' : ''}`} onClick={() => setOpen(a)}>
                  <td>
                    <strong>{a.name}</strong>
                    <div className="xs muted">
                      {ASSET_CATEGORY_LABELS[a.category]} · {Math.round(a.lifeMonths / 12 * 10) / 10} years
                      {a.disposedOn ? ` · sold/scrapped ${formatDate(a.disposedOn)}` : ''}
                    </div>
                  </td>
                  <td className="hide-sm nowrap">{formatDate(a.purchaseDate)}</td>
                  <td className="num">
                    <Money cents={a.costCents} />
                  </td>
                  <td className="num hide-sm">
                    <Money cents={a.accumulatedCents} />
                  </td>
                  <td className="num strong">
                    <Money cents={a.disposedOn ? 0 : a.costCents - a.accumulatedCents} />
                  </td>
                  <td className="num hide-md">
                    <Money cents={a.depreciationThisYearCents || null} />
                  </td>
                </tr>
              ))}
              <tr className="grand">
                <td>In use</td>
                <td className="hide-sm" />
                <td className="num">
                  <Money cents={totals.cost} />
                </td>
                <td className="num hide-sm">
                  <Money cents={totals.acc} />
                </td>
                <td className="num">
                  <Money cents={totals.cost - totals.acc} />
                </td>
                <td className="hide-md" />
              </tr>
            </tbody>
          </table>
        </section>
      ) : (
        <div className="panel">
          <Empty title="No assets yet">Add one here, or open a cost and choose “This is an asset”. A bakkie you sold to the company goes here too, paid from your loan account.</Empty>
        </div>
      )}
      {open && <AssetDrawer asset={open === 'new' ? null : open} onClose={() => setOpen(null)} onSaved={reload} />}
    </div>
  );
}

function AssetDrawer({ asset, onClose, onSaved }: { asset: AssetRow | null; onClose: () => void; onSaved: () => void }) {
  const { ref, isOwner } = useAuthed();
  const toast = useToast();
  const [f, setF] = useState({
    name: asset?.name ?? '',
    category: (asset?.category ?? 'tools') as AssetCategory,
    purchaseDate: asset?.purchaseDate ?? todayIso(),
    costCents: asset?.costCents ?? (null as number | null),
    sourceId: asset?.sourceId ?? ref.sources.find((s) => s.kind === 'owner')?.id ?? null,
    costId: asset?.costId ?? null,
    lifeMonths: asset?.lifeMonths ?? 36,
    residualCents: asset?.residualCents ?? 0,
    disposedOn: asset?.disposedOn ?? null,
    disposalProceedsCents: asset?.disposalProceedsCents ?? 0,
    disposalSourceId: asset?.disposalSourceId ?? null,
    notes: asset?.notes ?? '',
  });
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...f, costCents: f.costCents ?? 0 };
      if (asset) await api(`/api/assets/${asset.id}`, { method: 'PUT', body });
      else await api('/api/assets', { body });
      toast('Asset saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  const del = async () => {
    if (!asset || !confirm('Remove this asset from the register?')) return;
    await api(`/api/assets/${asset.id}`, { method: 'DELETE' });
    onSaved();
    onClose();
  };
  return (
    <Drawer title={asset ? asset.name : 'Add an asset'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">{(p) => <input {...p} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="e.g. Isuzu KB bakkie" />}</Field>
        <div className="form-grid">
          <Field label="Kind">
            {(p) => (
              <select {...p} className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as AssetCategory })}>
                {ASSET_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {ASSET_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Bought on">{(p) => <input {...p} className="input" type="date" value={f.purchaseDate} onChange={(e) => setF({ ...f, purchaseDate: e.target.value })} />}</Field>
        </div>
        {f.costId ? (
          <div className="banner small">Bought through a cost entry, so the cost comes from there ({formatZar(f.costCents ?? 0)}).</div>
        ) : (
          <div className="form-grid">
            <Field label="Cost">{(p) => <MoneyInput {...p} value={f.costCents} onChange={(c) => setF({ ...f, costCents: c })} />}</Field>
            <Field label="Paid from" hint="“Paid personally” if you sold it to the company: it goes onto your loan account.">
              {(p) => (
                <select {...p} className="select" value={f.sourceId ?? ''} onChange={(e) => setF({ ...f, sourceId: e.target.value || null })}>
                  {ref.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        )}
        <div className="form-grid">
          <Field label="Useful life (months)" hint="Tools 36, vehicles 60 are common">{(p) => <input {...p} className="input" type="number" min={1} value={f.lifeMonths} onChange={(e) => setF({ ...f, lifeMonths: Number(e.target.value) })} />}</Field>
          <Field label="Worth at the end">{(p) => <MoneyInput {...p} value={f.residualCents} onChange={(c) => setF({ ...f, residualCents: c ?? 0 })} />}</Field>
        </div>
        <fieldset className="fieldset">
          <legend>Sold or scrapped</legend>
          <div className="form-grid">
            <Field label="Date">{(p) => <input {...p} className="input" type="date" value={f.disposedOn ?? ''} onChange={(e) => setF({ ...f, disposedOn: e.target.value || null })} />}</Field>
            <Field label="Sold for">{(p) => <MoneyInput {...p} value={f.disposalProceedsCents} onChange={(c) => setF({ ...f, disposalProceedsCents: c ?? 0 })} />}</Field>
            <Field label="Money went to">
              {(p) => (
                <select {...p} className="select" value={f.disposalSourceId ?? ''} onChange={(e) => setF({ ...f, disposalSourceId: e.target.value || null })}>
                  <option value="">Business bank</option>
                  {ref.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </fieldset>
        <Field label="Notes">{(p) => <textarea {...p} className="textarea" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        {isOwner && (
          <div className="row">
            <button className="btn primary">Save</button>
            {asset && (
              <button type="button" className="btn danger" onClick={() => void del()}>
                Remove
              </button>
            )}
          </div>
        )}
      </form>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- balance checks */
interface Check {
  id: string;
  accountId: string;
  accountName: string;
  accountType: string;
  code: string;
  date: string;
  statementBalanceCents: number;
  booksCents: number;
  note: string;
}

function BalanceChecks() {
  const { ref, isOwner } = useAuthed();
  const toast = useToast();
  const { data, error, reload } = useApi<Check[]>('/api/balance-checks');
  const checkable = ref.accounts.filter((a) => a.type === 'asset' || a.type === 'liability');
  const [f, setF] = useState({ accountId: ref.accounts.find((a) => a.systemKey === 'bank')?.id ?? '', date: todayIso(), statementBalanceCents: null as number | null, note: '' });
  const [fixing, setFixing] = useState<Check | null>(null);
  const [against, setAgainst] = useState(ref.accounts.find((a) => a.systemKey === 'owner_loan')?.id ?? '');
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (f.statementBalanceCents == null) return;
    try {
      await api('/api/balance-checks', { body: { ...f, statementBalanceCents: f.statementBalanceCents } });
      setF({ ...f, statementBalanceCents: null, note: '' });
      void reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save', 'error');
    }
  };
  const fix = async () => {
    if (!fixing) return;
    try {
      await api(`/api/balance-checks/${fixing.id}/adjust`, { body: { againstAccountId: against } });
      toast('Adjustment journal posted');
      setFixing(null);
      void reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t post', 'error');
    }
  };
  const acct = ref.accounts.find((a) => a.id === f.accountId);
  return (
    <div className="stack">
      <div className="banner small">
        Check the books against your statements now and then: the bank, each card, and your loan account. Money moved between accounts (a card paid off from
        the bank, the company repaying you) isn’t a cost, so if you didn’t record it as a journal it shows up here as a difference. One tap posts it.
      </div>
      {isOwner && (
        <form className="panel panel-pad form-grid" onSubmit={add}>
          <Field label="Account">
            {(p) => (
              <select {...p} className="select" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
                {checkable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Statement date">{(p) => <input {...p} className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
          <Field label={acct?.type === 'liability' ? 'Amount owed on the statement' : 'Balance on the statement'}>
            {(p) => <MoneyInput {...p} value={f.statementBalanceCents} onChange={(c) => setF({ ...f, statementBalanceCents: c })} allowNegative />}
          </Field>
          <div className="field">
            <span className="label">&nbsp;</span>
            <button className="btn primary">Check</button>
          </div>
        </form>
      )}
      <ErrorBox error={error} />
      {data && data.length > 0 && (
        <section className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Date</th>
                <th className="num">Statement</th>
                <th className="num">Books</th>
                <th className="num">Difference</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((c) => {
                const diff = c.statementBalanceCents - c.booksCents;
                return (
                  <tr key={c.id}>
                    <td>
                      <span className="code">{c.code}</span> {c.accountName}
                    </td>
                    <td className="nowrap">{formatDate(c.date)}</td>
                    <td className="num">
                      <Money cents={c.statementBalanceCents} />
                    </td>
                    <td className="num">
                      <Money cents={c.booksCents} />
                    </td>
                    <td className={`num ${diff ? 'warn-text strong' : ''}`}>{diff ? formatZar(diff) : 'Agrees'}</td>
                    <td className="nowrap">
                      {diff !== 0 && isOwner && (
                        <button className="btn small" onClick={() => setFixing(c)}>
                          Fix…
                        </button>
                      )}
                      {isOwner && (
                        <button className="btn quiet small" aria-label="Remove check" onClick={() => void api(`/api/balance-checks/${c.id}`, { method: 'DELETE' }).then(reload)}>
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      {fixing && (
        <Drawer title={`Agree ${fixing.accountName}`} sub={`Difference ${formatZar(fixing.statementBalanceCents - fixing.booksCents)} at ${formatDate(fixing.date)}`} onClose={() => setFixing(null)}>
          <div className="stack">
            <p className="small">Where did the difference go? Usually the bank and your loan account move together: the company paid you back, or paid your card.</p>
            <Field label="Post the difference against">
              {(p) => (
                <select {...p} className="select" value={against} onChange={(e) => setAgainst(e.target.value)}>
                  {ref.accounts.filter((a) => a.id !== fixing.accountId).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <button className="btn primary big block" onClick={() => void fix()}>
              Post adjustment
            </button>
          </div>
        </Drawer>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- exports */
function Exports() {
  const { fy, today } = usePeriods();
  const [range, setRange] = useState({ from: fy.start, to: today });
  const qs = `from=${range.from}&to=${range.to}`;
  const items: [string, string, ReactNode][] = useMemo(
    () => [
      ['General ledger', `/api/export/ledger?${qs}`, 'Every posting, for your accountant or another package'],
      ['Trial balance', `/api/reports/trial-balance?date=${range.to}&format=csv`, `At ${formatDate(range.to)}`],
      ['Income statement by month', `/api/reports/income-statement?${qs}&by=month&format=csv`, 'The Trade Statement view'],
      ['Balance sheet', `/api/reports/balance-sheet?date=${range.to}&format=csv`, `At ${formatDate(range.to)}`],
      ['Invoices', `/api/export/invoices?${qs}`, 'With amounts paid and owing'],
      ['Payments received', `/api/export/receipts?${qs}`, ''],
      ['Costs', `/api/export/costs?${qs}`, 'With type, job and how it was paid'],
      ['Labour days', `/api/export/labour?${qs}`, 'Who worked where, wages and allowances'],
      ['Wage payments', `/api/export/wage-payments?${qs}`, ''],
    ],
    [qs, range.to],
  );
  return (
    <div className="stack">
      <PeriodPicker from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
      <section className="panel">
        <ul className="list">
          {items.map(([label, href, sub]) => (
            <li key={label}>
              <a className="list-row" href={apiUrl(href)}>
                <Icon name="download" size={18} />
                <span className="grow">
                  <strong>{label}</strong>
                  {sub && <div className="xs muted">{sub}</div>}
                </span>
                <span className="small muted">CSV</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
