import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatDate, formatZar } from '@shap/shared';
import { Drawer, Empty, ErrorBox, Field, Icon, Loading, Money, Segmented, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';

type State = 'open' | 'suggested' | 'matched' | 'ignored';
interface Line {
  id: string;
  statementId: string;
  date: string;
  description: string;
  amountCents: number;
  balanceCents: number | null;
  state: State;
  matches: { kind: string; id: string; label: string; amountCents: number }[];
  suggestion: { kind: string; ids: string[]; score: number; label: string } | null;
  supplier: string;
  categoryId: string | null;
}
interface Recon {
  source: { name: string } | null;
  statementBalance: { date: string; cents: number } | null;
  booksCents: number | null;
  lines: Line[];
}
interface Preview {
  columns: { date: string; description: string; amount: string; balance: string | null };
  count: number;
  duplicates: number;
  skipped: number;
  from: string;
  to: string;
  inCents: number;
  outCents: number;
  looksFlipped: boolean;
  sample: { date: string; description: string; amountCents: number; balanceCents: number | null }[];
}

type View = 'todo' | 'matched' | 'ignored' | 'all';

/**
 * Bank and card statements: import the CSV, let Shap match each line to what's captured
 * (a slip captured item by item is found from the statement total), then deal with the rest:
 * add bank fees and debit orders as costs, record client payments, book transfers, or leave
 * lines off (personal spending).
 */
export function BankRecon() {
  const { ref, isOwner } = useAuthed();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const sources = ref.sources.filter((s) => s.active && s.kind !== 'cash');
  const sourceId = params.get('source') ?? sources.find((s) => s.kind === 'bank')?.id ?? sources[0]?.id ?? '';
  const [view, setView] = useState<View>('todo');
  const { data, error, loading, reload } = useApi<Recon>(sourceId ? `/api/bank/recon?sourceId=${sourceId}` : null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, { categoryId?: string; supplier?: string }>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<null | { kind: 'match' | 'transfer'; line: Line }>(null);
  const [showImport, setShowImport] = useState(false);

  // Everything to do starts ticked: untick what you want left off.
  useEffect(() => {
    if (!data) return;
    setTicked(new Set(data.lines.filter((l) => l.state === 'open' || l.state === 'suggested').map((l) => l.id)));
    setDismissed(new Set());
  }, [data]);

  const lines = useMemo(() => {
    const all = (data?.lines ?? []).map((l) => (l.state === 'suggested' && dismissed.has(l.id) ? { ...l, state: 'open' as State, suggestion: null } : l));
    const show = view === 'todo' ? (l: Line) => l.state === 'open' || l.state === 'suggested' : view === 'all' ? () => true : (l: Line) => l.state === view;
    return all.filter(show);
  }, [data, view, dismissed]);
  const counts = useMemo(() => {
    const c = { open: 0, suggested: 0, matched: 0, ignored: 0 };
    for (const l of data?.lines ?? []) c[l.state]++;
    return c;
  }, [data]);

  const todo = lines.filter((l) => l.state === 'open' || l.state === 'suggested');
  const tickedSuggested = todo.filter((l) => ticked.has(l.id) && l.state === 'suggested');
  const tickedNewCosts = todo.filter((l) => ticked.has(l.id) && l.state === 'open' && l.amountCents < 0 && (edits[l.id]?.categoryId ?? l.categoryId));
  const unticked = todo.filter((l) => !ticked.has(l.id));

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) toast(msg);
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Something went wrong', 'error');
    } finally {
      setBusy(false);
    }
  };

  const captureTicked = () =>
    run(async () => {
      let matched = 0;
      let created = 0;
      if (tickedSuggested.length) matched = (await api<{ matched: number }>('/api/bank/accept', { body: { sourceId, lineIds: tickedSuggested.map((l) => l.id) } })).matched;
      if (tickedNewCosts.length) {
        created = (
          await api<{ created: number }>('/api/bank/lines/create-costs', {
            body: { items: tickedNewCosts.map((l) => ({ lineId: l.id, categoryId: edits[l.id]?.categoryId ?? l.categoryId, supplier: edits[l.id]?.supplier ?? l.supplier })) },
          })
        ).created;
      }
      return [matched && `${matched} matched`, created && `${created} added as costs`].filter(Boolean).join(', ') || 'Nothing to capture';
    });
  const leaveOff = (ids: string[], ignored = true) =>
    run(async () => {
      await api('/api/bank/lines/ignore', { body: { lineIds: ids, ignored } });
      return ignored ? `${ids.length} left off` : 'Brought back';
    });

  if (!sources.length) return <Empty title="No accounts yet">Add your bank account under Settings → Lists → Paid from / into.</Empty>;
  const diff = data?.statementBalance && data.booksCents != null ? data.statementBalance.cents - data.booksCents : null;

  return (
    <div className="stack-lg">
      <section className="panel panel-pad stack">
        <div className="toolbar wrap">
          <select className="select auto" value={sourceId} onChange={(e) => setParams({ tab: 'bank', source: e.target.value })} aria-label="Account">
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {isOwner && (
            <button className="btn primary" onClick={() => setShowImport((x) => !x)}>
              <Icon name="upload" size={18} />
              Import a statement
            </button>
          )}
          <span className="grow" />
          {data?.statementBalance && (
            <span className="small">
              Statement {formatDate(data.statementBalance.date)}: <strong>{formatZar(data.statementBalance.cents)}</strong> · books <strong>{formatZar(data.booksCents ?? 0)}</strong>
              {diff ? <span className="chip warn" style={{ marginLeft: 6 }}>{formatZar(diff)} apart</span> : <span className="chip ok" style={{ marginLeft: 6 }}>agrees</span>}
            </span>
          )}
        </div>
        {showImport && <ImportStatement sourceId={sourceId} sourceName={sources.find((s) => s.id === sourceId)?.name ?? ''} onDone={() => (setShowImport(false), void reload())} />}
        <p className="xs muted">
          Shap matches each line to what you captured: a slip captured item by item is found from the statement’s total. Untick anything you don’t want in
          the books (personal spending) and leave it off. Bank fees and debit orders you never captured are added as costs with one click.
        </p>
      </section>

      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data && data.lines.length ? (
        <>
          <div className="toolbar wrap">
            <Segmented
              label="Show"
              value={view}
              onChange={setView}
              options={[
                { value: 'todo', label: `To do (${counts.open + counts.suggested})` },
                { value: 'matched', label: `Matched (${counts.matched})` },
                { value: 'ignored', label: `Left off (${counts.ignored})` },
                { value: 'all', label: 'All' },
              ]}
            />
          </div>
          {lines.length ? (
            <div className="panel table-wrap">
              <table className="table bank-table">
                <thead>
                  <tr>
                    {view === 'todo' && isOwner && (
                      <th style={{ width: 34 }}>
                        <input type="checkbox" aria-label="Tick all" checked={todo.every((l) => ticked.has(l.id))} onChange={(e) => setTicked(new Set(e.target.checked ? todo.map((l) => l.id) : []))} />
                      </th>
                    )}
                    <th>Date</th>
                    <th>On the statement</th>
                    <th className="num">Amount</th>
                    <th>In Shap</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className={view === 'todo' && !ticked.has(l.id) ? 'inactive' : ''}>
                      {view === 'todo' && isOwner && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Include ${l.description}`}
                            checked={ticked.has(l.id)}
                            onChange={() =>
                              setTicked((t) => {
                                const n = new Set(t);
                                if (n.has(l.id)) n.delete(l.id);
                                else n.add(l.id);
                                return n;
                              })
                            }
                          />
                        </td>
                      )}
                      <td className="nowrap">{formatDate(l.date)}</td>
                      <td className="bank-desc">{l.description}</td>
                      <td className={`num ${l.amountCents > 0 ? 'ok-text' : ''}`}>
                        <Money cents={l.amountCents} />
                      </td>
                      <td className="bank-what">
                        <LineAction
                          line={l}
                          edit={edits[l.id] ?? {}}
                          onEdit={(e) => setEdits((x) => ({ ...x, [l.id]: { ...x[l.id], ...e } }))}
                          busy={busy}
                          canEdit={isOwner}
                          onAccept={() => run(async () => ((await api<{ matched: number }>('/api/bank/accept', { body: { sourceId, lineIds: [l.id] } })).matched ? 'Matched' : 'Already matched'))}
                          onDismiss={() => setDismissed((d) => new Set(d).add(l.id))}
                          onUnmatch={() => run(async () => (await api(`/api/bank/lines/${l.id}/match`, { method: 'DELETE' }), 'Unmatched'))}
                          onBringBack={() => void leaveOff([l.id], false)}
                          onLeaveOff={() => void leaveOff([l.id])}
                          onFind={() => setDrawer({ kind: 'match', line: l })}
                          onTransfer={() => setDrawer({ kind: 'transfer', line: l })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="panel">
              <Empty title={view === 'todo' ? 'All reconciled' : 'Nothing here'}>{view === 'todo' ? 'Every line is matched or left off.' : 'Try another view.'}</Empty>
            </div>
          )}
          {view === 'todo' && isOwner && todo.length > 0 && (
            <section className="panel panel-pad sticky-bar row wrap">
              <span className="grow small">
                {tickedSuggested.length > 0 && `${tickedSuggested.length} to match`}
                {tickedSuggested.length > 0 && tickedNewCosts.length > 0 && ' · '}
                {tickedNewCosts.length > 0 && `${tickedNewCosts.length} to add as costs`}
                {!tickedSuggested.length && !tickedNewCosts.length && 'Tick lines to capture them'}
              </span>
              {unticked.length > 0 && (
                <button className="btn" disabled={busy} onClick={() => void leaveOff(unticked.map((l) => l.id))}>
                  Leave off unticked ({unticked.length})
                </button>
              )}
              <button className="btn primary" disabled={busy || (!tickedSuggested.length && !tickedNewCosts.length)} onClick={() => void captureTicked()}>
                {busy ? 'Working…' : `Capture ticked (${tickedSuggested.length + tickedNewCosts.length})`}
              </button>
            </section>
          )}
        </>
      ) : (
        <div className="panel">
          <Empty title="No statement yet">Export this account’s transactions as CSV from online banking and import them here.</Empty>
        </div>
      )}
      {drawer?.kind === 'match' && <MatchDrawer line={drawer.line} onClose={() => setDrawer(null)} onDone={() => (setDrawer(null), void reload())} />}
      {drawer?.kind === 'transfer' && <TransferDrawer sourceId={sourceId} line={drawer.line} onClose={() => setDrawer(null)} onDone={() => (setDrawer(null), void reload())} />}
    </div>
  );
}

function LineAction(p: {
  line: Line;
  edit: { categoryId?: string; supplier?: string };
  onEdit: (e: { categoryId?: string; supplier?: string }) => void;
  busy: boolean;
  canEdit: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onUnmatch: () => void;
  onBringBack: () => void;
  onLeaveOff: () => void;
  onFind: () => void;
  onTransfer: () => void;
}) {
  const { ref } = useAuthed();
  const l = p.line;
  if (l.state === 'matched')
    return (
      <div className="stack" style={{ gap: 2 }}>
        {l.matches.map((m) => (
          <span key={m.id} className="small">
            <Icon name="check" size={12} /> {m.label} <span className="muted">{formatZar(m.amountCents)}</span>
          </span>
        ))}
        {p.canEdit && (
          <button className="btn quiet small" style={{ alignSelf: 'flex-start' }} onClick={p.onUnmatch} disabled={p.busy}>
            Unmatch
          </button>
        )}
      </div>
    );
  if (l.state === 'ignored')
    return (
      <span className="row small">
        <span className="muted grow">Left off</span>
        {p.canEdit && (
          <button className="btn quiet small" onClick={p.onBringBack} disabled={p.busy}>
            Bring back
          </button>
        )}
      </span>
    );
  if (!p.canEdit) return <span className="muted small">{l.suggestion ? `Looks like: ${l.suggestion.label}` : 'Not matched yet'}</span>;
  const more = (
    <span className="row wrap" style={{ gap: 4 }}>
      <button className="btn quiet small" onClick={p.onFind} disabled={p.busy}>
        {l.amountCents < 0 ? 'Find the costs' : 'Choose invoice'}
      </button>
      <button className="btn quiet small" onClick={p.onTransfer} disabled={p.busy}>
        Transfer
      </button>
      <button className="btn quiet small" onClick={p.onLeaveOff} disabled={p.busy}>
        Leave off
      </button>
    </span>
  );
  if (l.state === 'suggested' && l.suggestion)
    return (
      <div className="stack" style={{ gap: 4 }}>
        <span className="small">
          <span className={`chip ${l.suggestion.kind === 'invoice' ? '' : 'ok'}`}>{l.suggestion.kind === 'invoice' ? 'record payment' : 'match'}</span> {l.suggestion.label}
        </span>
        <span className="row wrap" style={{ gap: 4 }}>
          <button className="btn small" onClick={p.onAccept} disabled={p.busy}>
            {l.suggestion.kind === 'invoice' ? 'Record it' : 'Match'}
          </button>
          <button className="btn quiet small" onClick={p.onDismiss}>
            Not this
          </button>
          {more}
        </span>
      </div>
    );
  if (l.amountCents < 0)
    return (
      <div className="stack" style={{ gap: 4 }}>
        <span className="xs muted">Not captured: add it as a cost</span>
        <div className="row wrap" style={{ gap: 6 }}>
          <select className="select auto small-select" value={p.edit.categoryId ?? l.categoryId ?? ''} onChange={(e) => p.onEdit({ categoryId: e.target.value })} aria-label="Cost type">
            <option value="">Cost type…</option>
            {ref.categories.filter((c) => c.active).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input className="input small-input" value={p.edit.supplier ?? l.supplier} onChange={(e) => p.onEdit({ supplier: e.target.value })} aria-label="Supplier" />
        </div>
        {more}
      </div>
    );
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="xs muted">Money in, not matched to an invoice</span>
      {more}
    </div>
  );
}

function ImportStatement({ sourceId, sourceName, onDone }: { sourceId: string; sourceName: string; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [flip, setFlip] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const look = async (f: { name: string; csv: string }, flipIt: boolean) => {
    setBusy(true);
    setError('');
    try {
      const p = await api<Preview>('/api/bank/preview', { body: { sourceId, csv: f.csv, filename: f.name, flip: flipIt } });
      setPreview(p);
      return p;
    } catch (err) {
      setPreview(null);
      setError(err instanceof ApiError ? err.message : 'Couldn’t read that file');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const choose = async (f: File | undefined) => {
    if (!f) return;
    const next = { name: f.name, csv: await f.text() };
    setFile(next);
    const p = await look(next, false);
    if (p?.looksFlipped) {
      setFlip(true);
      await look(next, true);
    } else setFlip(false);
  };
  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await api<{ added: number; duplicates: number; autoMatched: number }>('/api/bank/statements', { body: { sourceId, csv: file.csv, filename: file.name, flip } });
      toast(`${r.added} transactions added${r.duplicates ? `, ${r.duplicates} already here` : ''}${r.autoMatched ? `, ${r.autoMatched} matched straight away` : ''}`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fieldset stack">
      <strong>Import into {sourceName}</strong>
      <p className="xs muted">In online banking, download the account’s transactions as CSV (any date range; lines already imported are skipped).</p>
      <label className="btn">
        <Icon name="upload" size={18} />
        {busy && !preview ? 'Reading…' : file ? `Choose another file (${file.name})` : 'Choose the CSV file'}
        <input type="file" accept=".csv,text/csv,.txt" hidden onChange={(e) => void choose(e.target.files?.[0])} />
      </label>
      {error && <div className="banner alert small">{error}</div>}
      {preview && file && (
        <>
          <p className="small">
            <strong>{preview.count}</strong> transactions, {formatDate(preview.from)} to {formatDate(preview.to)}: money in {formatZar(preview.inCents)}, money out{' '}
            {formatZar(preview.outCents)}.{preview.duplicates > 0 && ` ${preview.duplicates} are already imported and will be skipped.`}
            <br />
            <span className="xs muted">
              Read from columns: {preview.columns.date} · {preview.columns.description} · {preview.columns.amount}
              {preview.columns.balance ? ` · ${preview.columns.balance}` : ''}
            </span>
          </p>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {preview.sample.map((r, i) => (
                  <tr key={i}>
                    <td className="nowrap small">{formatDate(r.date)}</td>
                    <td className="small">{r.description}</td>
                    <td className={`num small ${r.amountCents > 0 ? 'ok-text' : ''}`}>{formatZar(r.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="check small">
            <input type="checkbox" checked={flip} onChange={(e) => (setFlip(e.target.checked), void look(file, e.target.checked))} />
            Money out shows as positive on this statement (common on card statements): flip it
          </label>
          <button className="btn primary big" disabled={busy || preview.count === preview.duplicates} onClick={() => void doImport()}>
            {busy ? 'Importing…' : `Import ${preview.count - preview.duplicates} transactions`}
          </button>
        </>
      )}
    </div>
  );
}

interface Candidates {
  costs: { id: string; date: string; amountCents: number; description: string; supplier: string; sourceName: string | null; projectName: string | null }[];
  wages: { id: string; date: string; amountCents: number; workerName: string }[];
  invoices: { id: string; number: string; issueDate: string; clientName: string | null; balanceCents: number }[];
}

function MatchDrawer({ line, onClose, onDone }: { line: Line; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data, error } = useApi<Candidates>(`/api/bank/lines/${line.id}/candidates`);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const target = Math.abs(line.amountCents);
  const items = data ? [...data.costs.map((c) => ({ key: `cost:${c.id}`, amount: c.amountCents })), ...data.wages.map((w) => ({ key: `wage_payment:${w.id}`, amount: w.amountCents }))] : [];
  const sum = items.filter((i) => picked.has(i.key)).reduce((s, i) => s + i.amount, 0);
  const toggle = (k: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const save = async (body: unknown, path: string) => {
    setBusy(true);
    try {
      await api(path, { body });
      toast('Matched');
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t match', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer title={line.amountCents < 0 ? 'Which costs are these?' : 'Which invoice does this pay?'} sub={`${formatDate(line.date)} · ${line.description} · ${formatZar(line.amountCents)}`} onClose={onClose} wide>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : line.amountCents < 0 ? (
        <div className="stack">
          <p className="small">Tick the costs (from the two weeks around the date) that this payment covers. They must add up to {formatZar(target)}.</p>
          <ul className="list">
            {data.costs.map((c) => (
              <li key={c.id}>
                <label className="list-row">
                  <input type="checkbox" checked={picked.has(`cost:${c.id}`)} onChange={() => toggle(`cost:${c.id}`)} />
                  <span className="grow small">
                    {c.description}
                    <div className="xs muted">
                      {formatDate(c.date)}
                      {c.supplier ? ` · ${c.supplier}` : ''} · {c.sourceName ?? 'not captured'}
                      {c.projectName ? ` · ${c.projectName}` : ''}
                    </div>
                  </span>
                  <Money cents={c.amountCents} />
                </label>
              </li>
            ))}
            {data.wages.map((w) => (
              <li key={w.id}>
                <label className="list-row">
                  <input type="checkbox" checked={picked.has(`wage_payment:${w.id}`)} onChange={() => toggle(`wage_payment:${w.id}`)} />
                  <span className="grow small">
                    Wages: {w.workerName}
                    <div className="xs muted">{formatDate(w.date)}</div>
                  </span>
                  <Money cents={w.amountCents} />
                </label>
              </li>
            ))}
            {!data.costs.length && !data.wages.length && <li className="panel-pad small muted">Nothing unmatched near this date. Add it as a cost instead.</li>}
          </ul>
          <div className="sticky-bar panel panel-pad row">
            <span className="grow small">
              Ticked {formatZar(sum)} of {formatZar(target)}
              {sum !== target && sum > 0 && <span className="warn-text"> ({formatZar(target - sum)} to go)</span>}
            </span>
            <button
              className="btn primary"
              disabled={busy || sum !== target}
              onClick={() => void save({ items: [...picked].map((k) => ({ kind: k.split(':')[0], id: k.split(':')[1] })) }, `/api/bank/lines/${line.id}/match`)}
            >
              Match
            </button>
          </div>
        </div>
      ) : (
        <ul className="list">
          {data.invoices.map((i) => (
            <li key={i.id}>
              <button className="list-row" disabled={busy} onClick={() => void save({ invoiceId: i.id }, `/api/bank/lines/${line.id}/receipt`)}>
                <span className="grow small">
                  Invoice {i.number}
                  {i.clientName ? ` · ${i.clientName}` : ''}
                  <div className="xs muted">{formatDate(i.issueDate)}</div>
                </span>
                <Money cents={i.balanceCents} />
                {i.balanceCents === target && <span className="chip ok">exact</span>}
              </button>
            </li>
          ))}
          {!data.invoices.length && <li className="panel-pad small muted">No invoices are owing.</li>}
        </ul>
      )}
    </Drawer>
  );
}

function TransferDrawer({ sourceId, line, onClose, onDone }: { sourceId: string; line: Line; onClose: () => void; onDone: () => void }) {
  const { ref } = useAuthed();
  const toast = useToast();
  const others = ref.sources.filter((s) => s.active && s.id !== sourceId);
  const [other, setOther] = useState(others[0]?.id ?? '');
  const [description, setDescription] = useState('');
  const out = line.amountCents < 0;
  return (
    <Drawer title="Transfer between your accounts" sub={`${formatDate(line.date)} · ${line.description} · ${formatZar(line.amountCents)}`} onClose={onClose}>
      <div className="stack">
        <p className="small">
          Money that moved between two of your own accounts: paying off the business card, the company paying you back, or you putting money in. Neither
          income nor a cost.
        </p>
        <Field label={out ? 'Went to' : 'Came from'}>
          {(p) => (
            <select {...p} className="select" value={other} onChange={(e) => setOther(e.target.value)}>
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.accountName})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Description (optional)">{(p) => <input {...p} className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={out ? 'e.g. Card repayment' : 'e.g. Owner loan in'} />}</Field>
        <button
          className="btn primary big block"
          disabled={!other}
          onClick={() =>
            void api(`/api/bank/lines/${line.id}/transfer`, { body: { otherSourceId: other, description } })
              .then(() => (toast('Transfer booked'), onDone()))
              .catch((err) => toast(err instanceof ApiError ? err.message : 'Couldn’t book it', 'error'))
          }
        >
          Book the transfer
        </button>
      </div>
    </Drawer>
  );
}
