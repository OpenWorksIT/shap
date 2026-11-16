/**
 * Accounts → From another package (Shap Accountant, docs/ACCOUNTANT.md): a client's trial balance
 * and general ledger, exported from their own package (Xero, QuickBooks, Sage or Pastel), brought
 * into these books period by period, to check and compile here while they keep working there.
 * Choose the files, see what Shap read in them and where each of their accounts goes, then bring
 * them in at once. The accounts chosen are remembered, so next period's files map by themselves.
 */
import { useState } from 'react';
import { ACCOUNT_TYPES, formatDate, STATEMENT_LINES, type AccountType } from '@shap/shared';
import { ErrorBox, Field, Icon, Loading, Money, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { UNEXPECTED } from '../lib/words';

interface ReadFile {
  name: string;
  kind: 'trialBalance' | 'ledger' | 'unknown';
  source: string;
  asAt: string | null;
  from: string | null;
  to: string | null;
  lines: number;
  debits: number;
  credits: number;
  already: number;
  outside: number;
  columns: string;
  skipped: string[];
}
interface CheckResult {
  created: number;
  results: {
    name: string;
    kind: 'ledger' | 'trialBalance';
    from: string;
    to: string;
    journals: number;
    yearFrom?: string;
    adjustments?: { code: string; name: string; cents: number }[];
    earlierYearsCents?: number;
    ownEntries?: number;
    opening?: boolean;
  }[];
}
interface Theirs {
  code: string;
  name: string;
  type: AccountType | null;
  accountId: string | null;
  how: 'as last time' | 'same name or code' | 'Shap’s own account for it' | 'new';
  /** Where a new one sits on the statements, from their file's words for its kind. */
  line: string | null;
  typeWords?: string;
}
interface Read {
  files: ReadFile[];
  accounts: Theirs[];
  ours: { id: string; code: string; name: string; type: AccountType }[];
}
interface Import {
  id: string;
  kind: 'trialBalance' | 'ledger';
  source: string;
  filename: string;
  dateFrom: string;
  dateTo: string;
  lines: number;
  createdAt: string;
  by: string | null;
}

const TYPE_WORDS: Record<AccountType, string> = { asset: 'an asset', liability: 'a liability', equity: 'equity', income: 'income', cost_of_sales: 'a cost of sales', expense: 'an expense' };
const GROUP_WORDS: Record<AccountType, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', cost_of_sales: 'Cost of sales', expense: 'Expenses' };
const KIND_WORDS = { trialBalance: 'Trial balance', ledger: 'General ledger', unknown: 'Not recognised' } as const;

const HOW: { name: string; steps: string }[] = [
  { name: 'Xero', steps: 'Reports → Trial Balance (at the date) and General Ledger Detail or Account Transactions (for the period) → Export → Excel or CSV.' },
  { name: 'QuickBooks Online', steps: 'Reports → Trial Balance (at the date) and Journal (for the period) → Export to Excel.' },
  { name: 'Sage Accounting', steps: 'Reports → Trial Balance “As of” the date, with “Summarise profit and loss values” ticked (so income and expenses are for the year), and Detailed General Ledger (or Account Transactions) → Export to Excel.' },
  { name: 'Sage Pastel', steps: 'Reports → Ledger → Trial Balance and Ledger Transactions → print to a file (Excel or CSV).' },
];

const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

export default function BooksImport() {
  const toast = useToast();
  const list = useApi<{ imports: Import[] }>('/api/books-import');
  const [files, setFiles] = useState<{ name: string; dataBase64: string; asAt: string | null }[]>([]);
  const [read, setRead] = useState<Read | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const key = (a: { code: string; name: string }) => `${a.code}|${a.name}`;

  const look = async (next: typeof files) => {
    setError('');
    setRead(null);
    if (!next.length) return;
    setBusy(true);
    try {
      const r = await api<Read>('/api/books-import/read', { body: { files: next } });
      setRead(r);
      // As Shap suggests: an account in these books, or a new one of the type their file gives.
      setMapping(Object.fromEntries(r.accounts.map((a) => [key(a), a.accountId ?? (a.type ? `new:${a.type}` : '')])));
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      setError(err instanceof ApiError ? err.message : UNEXPECTED);
    } finally {
      setBusy(false);
    }
  };
  const choose = async (picked: FileList | null) => {
    if (!picked?.length) return;
    const added = await Promise.all([...picked].map(async (f) => ({ name: f.name, dataBase64: await toBase64(f), asAt: null })));
    const next = [...files.filter((f) => !added.some((a) => a.name === f.name)), ...added];
    setFiles(next);
    await look(next);
  };
  const dateFor = (name: string, asAt: string) => {
    const next = files.map((f) => (f.name === name ? { ...f, asAt: asAt || null } : f));
    setFiles(next);
    setCheck(null);
  };
  const body = () => ({
    files,
    mapping: (read?.accounts ?? []).map((a) => {
      const m = mapping[key(a)] ?? '';
      return { code: a.code, name: a.name, accountId: m && !m.startsWith('new:') ? m : null, newType: m.startsWith('new:') ? m.slice(4) : null };
    }),
  });
  // Run it all, undone, to see what it would do: each trial balance's adjustments before they're made.
  const checkFirst = async () => {
    setBusy(true);
    setError('');
    setCheck(null);
    try {
      setCheck(await api<CheckResult>('/api/books-import/check', { body: body() }));
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      setError(err instanceof ApiError ? err.message : UNEXPECTED);
    } finally {
      setBusy(false);
    }
  };
  const bringIn = async () => {
    if (!read) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<CheckResult>('/api/books-import/apply', { body: body() });
      toast(`Brought in: ${r.results.map((x) => `${x.name} (${x.journals} ${x.journals === 1 ? 'journal' : 'journals'})`).join(', ')}${r.created ? `, with ${r.created} new ${r.created === 1 ? 'account' : 'accounts'}` : ''}`);
      setFiles([]);
      setRead(null);
      setCheck(null);
      await list.reload();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      setError(err instanceof ApiError ? err.message : UNEXPECTED);
    } finally {
      setBusy(false);
    }
  };
  const takeOut = async (i: Import) => {
    if (!confirm(`Take out ${i.filename}? Every journal it brought in goes with it.`)) return;
    try {
      await api(`/api/books-import/${i.id}`, { method: 'DELETE' });
      await list.reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
    }
  };

  const needsDate = read?.files.some((f, i) => f.kind === 'trialBalance' && !f.asAt && !files[i]?.asAt);
  const unmapped = read?.accounts.some((a) => !mapping[key(a)]);
  const unread = read?.files.some((f) => f.kind === 'unknown' || f.outside > 0);
  return (
    <div className="stack-lg">
      <section className="panel panel-pad stack">
        <p className="small">
          Bring in a client’s books from the package they keep them in: its trial balance at a date, and its general ledger for a period. Each ledger comes in as its transactions; a trial balance brings every account to its figures on that date (for the year, the income and expenses; to date, the rest). The same period brought in again replaces what came in before.
        </p>
        <details className="small">
          <summary>How to export them</summary>
          <ul>
            {HOW.map((h) => (
              <li key={h.name}>
                <strong>{h.name}:</strong> {h.steps}
              </li>
            ))}
          </ul>
        </details>
        <label className="btn" style={{ alignSelf: 'flex-start' }}>
          <Icon name="upload" size={18} />
          Choose the files (Excel or CSV)
          <input type="file" multiple accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => void choose(e.target.files)} />
        </label>
        {busy && !read && <Loading />}
        {error && <div className="banner alert small">{error}</div>}
      </section>

      {read && (
        <>
          <section className="panel panel-pad stack">
            <h3>What’s in them</h3>
            <ul className="list">
              {read.files.map((f, i) => (
                <li key={f.name} className="list-row stack-sm" style={{ alignItems: 'stretch' }}>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <strong className="grow" data-private>
                      {f.name}
                    </strong>
                    <span className="chip">{KIND_WORDS[f.kind]}</span>
                    <span className="xs muted">from {f.source}</span>
                  </div>
                  {f.kind === 'unknown' ? (
                    <span className="small warn-text">{f.skipped[0] ?? 'Shap couldn’t find its headings.'}</span>
                  ) : (
                    <span className="small">
                      {f.kind === 'trialBalance' ? (f.asAt ? `At ${formatDate(f.asAt)}` : 'Its date isn’t in the file') : `${formatDate(f.from)} to ${formatDate(f.to)}`} · {f.lines} {f.kind === 'trialBalance' ? 'accounts' : 'lines'} · debits <Money cents={f.debits} />, credits <Money cents={f.credits} />
                      {f.debits !== f.credits && <span className="warn-text"> (they don’t balance: export it again with every account)</span>}
                    </span>
                  )}
                  {f.kind === 'trialBalance' && !f.asAt && (
                    <Field label="The trial balance’s date">{(p) => <input {...p} className="input" type="date" value={files[i]?.asAt ?? ''} onChange={(e) => dateFor(f.name, e.target.value)} />}</Field>
                  )}
                  {f.already > 0 && (
                    <span className="small warn-text">These books already have {f.already} entries in this period that weren’t brought in from a package: they’d be counted twice. Bring in a period these books don’t keep, or check before you go on.</span>
                  )}
                  {f.kind !== 'unknown' && f.columns && <span className="xs muted">Read from {f.columns}.</span>}
                  {f.outside > 0 && <span className="small warn-text">{f.outside} {f.outside === 1 ? 'line falls' : 'lines fall'} outside its period: check its dates (day or month first?) and export it again.</span>}
                  {f.skipped.length > 0 && f.kind !== 'unknown' && <span className="xs muted">Not read: {f.skipped.join('; ')}</span>}
                </li>
              ))}
            </ul>
          </section>

          <section className="panel panel-pad stack">
            <h3>Their accounts, and where each goes in these books</h3>
            <p className="xs muted">Shap suggests one where it used it last time, or where the code or the name is the same. Otherwise, a new account of the kind their file gives: choose one where it doesn’t say.</p>
            <ul className="list" data-private>
              {read.accounts.map((a) => (
                <li key={key(a)} className="list-row row wrap" style={{ gap: 8 }}>
                  <span className="grow small">
                    {a.code && <span className="muted">{a.code} </span>}
                    {a.name}
                    {a.typeWords && <span className="xs muted"> · {a.typeWords} in their file</span>}
                    {a.how !== 'new' && <span className="xs muted"> ({a.how})</span>}
                    {a.how === 'new' && a.line && <span className="xs muted"> · a new one goes on the statements as {STATEMENT_LINES[a.line as keyof typeof STATEMENT_LINES]?.label.toLowerCase() ?? a.line}</span>}
                  </span>
                  <select className="select" aria-label={`Where ${a.name} goes`} value={mapping[key(a)] ?? ''} onChange={(e) => (setMapping({ ...mapping, [key(a)]: e.target.value }), setCheck(null))} style={{ maxWidth: 320 }}>
                    <option value="">Choose…</option>
                    <optgroup label="A new account">
                      {ACCOUNT_TYPES.map((t) => (
                        <option key={t} value={`new:${t}`}>
                          New: {TYPE_WORDS[t]}
                        </option>
                      ))}
                    </optgroup>
                    {ACCOUNT_TYPES.map((t) => (
                      <optgroup key={t} label={`In these books: ${GROUP_WORDS[t]}`}>
                        {read.ours
                          .filter((o) => o.type === t)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.code} {o.name}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
            {!check ? (
              <button className="btn primary big" disabled={busy || Boolean(needsDate) || Boolean(unmapped) || Boolean(unread)} onClick={() => void checkFirst()}>
                {busy ? 'Checking…' : 'Check what it would do'}
              </button>
            ) : (
              <div className="stack">
                <h3>What bringing them in would do</h3>
                {check.created > 0 && <p className="small">{check.created} new {check.created === 1 ? 'account' : 'accounts'} in these books.</p>}
                {check.results.map((r) => (
                  <div key={r.name} className="stack-sm">
                    <strong className="small" data-private>
                      {r.name}
                    </strong>
                    {r.kind === 'ledger' ? (
                      <p className="small">
                        {r.journals} {r.journals === 1 ? 'journal' : 'journals'}, {formatDate(r.from)} to {formatDate(r.to)}, as their package has them.
                      </p>
                    ) : (
                      <>
                        <p className="small">
                          Brings what was brought in from the package to their trial balance at {formatDate(r.to)}: the income and expenses for {formatDate(r.yearFrom)} to {formatDate(r.to)} (these books’ year), the rest to date.
                          {r.ownEntries ? ` Your own ${r.ownEntries} ${r.ownEntries === 1 ? 'entry' : 'entries'} in these books up to then stay on top of it.` : ''}
                        </p>
                        {r.opening && (
                          <p className="small warn-text">
                            These books begin with it: before it, the comparatives, the opening equity and cash, the changes in equity and the cash flows start from nil. For statements, bring in the trial balance at the year end before it first (and the one before that, for comparatives).
                          </p>
                        )}
                        {r.earlierYearsCents ? (
                          <p className="small warn-text">
                            It gives the years before {formatDate(r.yearFrom)} <Money cents={Math.abs(r.earlierYearsCents)} /> {r.earlierYearsCents < 0 ? 'more' : 'less'} profit than what was brought in before: that goes to retained earnings on {formatDate(r.to)}. That’s a matter for the accountant (an earlier period’s figures changed in the package).
                          </p>
                        ) : null}
                        {r.adjustments && r.adjustments.length > 0 ? (
                          <ul className="list small" data-private>
                            {r.adjustments.map((a) => (
                              <li key={a.code + a.name} className="list-row">
                                <span className="grow">
                                  {a.code} {a.name}
                                </span>
                                <Money cents={a.cents} />
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="small">Nothing to move: what was brought in already gives these figures.</p>
                        )}
                      </>
                    )}
                  </div>
                ))}
                <div className="row wrap" style={{ gap: 8 }}>
                  <button className="btn primary big" disabled={busy} onClick={() => void bringIn()}>
                    {busy ? 'Bringing them in…' : 'Bring them in'}
                  </button>
                  <button className="btn quiet" disabled={busy} onClick={() => setCheck(null)}>
                    Change something first
                  </button>
                </div>
              </div>
            )}
            {(needsDate || unmapped || unread) && <span className="xs muted">{unread ? 'Take out the file Shap couldn’t read first. ' : ''}{needsDate ? 'Give each trial balance its date. ' : ''}{unmapped ? 'Choose where each account goes.' : ''}</span>}
          </section>
        </>
      )}

      <section className="panel panel-pad stack">
        <h3>Brought in</h3>
        {list.error ? (
          <ErrorBox error={list.error} onRetry={list.reload} />
        ) : !list.data ? (
          <Loading />
        ) : list.data.imports.length === 0 ? (
          <p className="small muted">Nothing brought in from another package yet.</p>
        ) : (
          <ul className="list">
            {list.data.imports.map((i) => (
              <li key={i.id} className="list-row row wrap" style={{ gap: 8 }}>
                <span className="grow small">
                  {KIND_WORDS[i.kind]} {i.kind === 'trialBalance' ? `at ${formatDate(i.dateTo)}` : `${formatDate(i.dateFrom)} to ${formatDate(i.dateTo)}`} from {i.source} <span className="muted" data-private>({i.filename}{i.by ? `, by ${i.by}` : ''})</span>
                </span>
                <button className="btn small quiet" onClick={() => void takeOut(i)}>
                  Take out
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
