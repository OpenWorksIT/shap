import { useMemo, useState } from 'react';
import { formatDate, formatPercent, formatZar, monthLabel } from '@shap/shared';
import { Drawer, Empty, ErrorBox, Field, Kpi, Loading, Money, MoneyInput, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { UNEXPECTED } from '../lib/words';

type Kind = 'income' | 'cost_of_sales' | 'expense';
interface Line {
  id: string;
  code: string;
  name: string;
  type: Kind;
  budget: number[] | null;
  actual: number[];
  lastYear: number[];
}
interface Report {
  fy: { start: string; end: string; label: string };
  months: string[];
  monthsDone: number;
  lines: Line[];
  years: string[];
}

const GROUPS: { type: Kind; label: string }[] = [
  { type: 'income', label: 'Income' },
  { type: 'cost_of_sales', label: 'Cost of sales' },
  { type: 'expense', label: 'Running costs' },
];
const sum = (xs: number[], n = 12) => xs.slice(0, n).reduce((t, x) => t + x, 0);

/**
 * Budgets: what each income statement account is expected to come to, month by month, in a
 * financial year, against what the books show so far. A plan, not the books: nothing posts from it.
 */
export function Budgets() {
  const { can, user } = useAuthed();
  const isOwner = user.role === 'owner';
  const toast = useToast();
  const [fyEnd, setFyEnd] = useState<string>('');
  const { data, error, loading, reload } = useApi<Report>(`/api/budgets${fyEnd ? `?fyEnd=${fyEnd}` : ''}`);
  const [editing, setEditing] = useState<Line | null>(null);
  const [percent, setPercent] = useState('0');
  const [busy, setBusy] = useState(false);
  // Accounts with nothing budgeted and nothing in the books (this year or last) are left out until asked for.
  const [every, setEvery] = useState(false);

  const totals = useMemo(() => {
    if (!data) return null;
    const done = data.monthsDone;
    const by = (t: Kind, k: 'budget' | 'actual', n: number) => data.lines.filter((l) => l.type === t).reduce((s, l) => s + sum((k === 'budget' ? l.budget : l.actual) ?? [], n), 0);
    const profit = (k: 'budget' | 'actual', n: number) => by('income', k, n) - by('cost_of_sales', k, n) - by('expense', k, n);
    return { budgetYear: profit('budget', 12), budgetToDate: profit('budget', done), actualToDate: profit('actual', done), incomeBudget: by('income', 'budget', done), incomeActual: by('income', 'actual', done) };
  }, [data]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data || !totals) return null;
  const hasBudget = data.lines.some((l) => l.budget);
  const done = data.monthsDone;
  const hasFigures = (l: Line) => Boolean(l.budget) || l.actual.some(Boolean) || l.lastYear.some(Boolean);
  const hidden = data.lines.filter((l) => !hasFigures(l)).length;

  const startFromLastYear = async () => {
    setBusy(true);
    try {
      const r = await api<{ filled: number }>('/api/budgets/from-last-year', { body: { fyEnd: data.fy.end, percent: Number(percent) || 0 } });
      toast(r.filled ? `${r.filled} accounts started from last year’s figures` : 'Nothing to start from: last year has no figures for accounts without a budget');
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <section className="panel panel-pad stack">
        <div className="toolbar wrap">
          <select className="select auto" value={data.fy.end} onChange={(e) => setFyEnd(e.target.value)} aria-label="Financial year">
            {data.years.map((y) => (
              <option key={y} value={y}>
                Year to {formatDate(y)}
              </option>
            ))}
          </select>
          {isOwner && (
            <span className="row wrap" style={{ gap: 6 }}>
              <button className="btn" disabled={busy} onClick={() => void startFromLastYear()}>
                Start from last year’s figures
              </button>
              <label className="row small" style={{ gap: 4 }}>
                changed by
                <input className="input small-input" type="number" min={-90} max={500} value={percent} onChange={(e) => setPercent(e.target.value)} style={{ width: 72 }} aria-label="Percent up or down" />%
              </label>
            </span>
          )}
        </div>
        <p className="xs muted">
          What you expect each account to come to, month by month, against what the books show. A plan for you, not the books: nothing is posted from it.
          {isOwner ? ' Tap an account to set its months.' : ' The owner sets the budget.'} Starting from last year fills only accounts without a budget yet.
        </p>
      </section>

      {hasBudget && (
        <div className="kpis">
          <Kpi label={`Profit budgeted for the year`} value={<Money cents={totals.budgetYear} whole />} />
          <Kpi label={done ? `Budget to ${monthLabel(data.months[done - 1]!)}` : 'Budget to date'} value={<Money cents={totals.budgetToDate} whole />} sub={done ? `income ${formatZar(totals.incomeBudget, { cents: false })}` : 'the year hasn’t started'} />
          <Kpi
            label="Actual to date"
            value={<Money cents={totals.actualToDate} whole />}
            sub={done ? `income ${formatZar(totals.incomeActual, { cents: false })}` : undefined}
            tone={done && totals.actualToDate < totals.budgetToDate ? 'warn' : undefined}
          />
        </div>
      )}

      {GROUPS.map((g) => {
        const lines = data.lines.filter((l) => l.type === g.type && (every || hasFigures(l)));
        if (!lines.length) return null;
        return (
          <section key={g.type} className="panel table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{g.label}</th>
                  <th className="num hide-sm">Budget, year</th>
                  <th className="num hide-sm">Budget to date</th>
                  <th className="num">Actual to date</th>
                  <th className="num">Difference</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const b = sum(l.budget ?? [], done);
                  const a = sum(l.actual, done);
                  // Better than budget: more income, or less cost.
                  const diff = g.type === 'income' ? a - b : b - a;
                  return (
                    <tr key={l.id} className={isOwner ? 'clickable' : ''} onClick={isOwner ? () => setEditing(l) : undefined}>
                      <td>
                        {l.name} <span className="xs muted">{l.code}</span>
                        {/* On a phone, the budget goes under the account, so actual and the difference fit beside it. */}
                        {l.budget && (
                          <span className="show-sm xs muted">
                            <br />
                            budget to date <span className="nowrap">{formatZar(b, { cents: false })}</span> of <span className="nowrap">{formatZar(sum(l.budget), { cents: false })}</span>
                          </span>
                        )}
                      </td>
                      <td className="num hide-sm">{l.budget ? <Money cents={sum(l.budget)} whole /> : <span className="muted">–</span>}</td>
                      <td className="num hide-sm">{l.budget ? <Money cents={b} whole /> : <span className="muted">–</span>}</td>
                      <td className="num">
                        <Money cents={a} whole />
                      </td>
                      <td className={`num ${l.budget && diff < 0 ? 'bad-figure' : ''}`}>
                        {l.budget ? (
                          <>
                            <Money cents={diff} whole />
                            {b ? <span className="xs muted"> {formatPercent(diff / Math.abs(b))}</span> : null}
                          </>
                        ) : (
                          ''
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
      {isOwner && hidden > 0 && (
        <button className="btn quiet" onClick={() => setEvery(!every)}>
          {every ? 'Only the accounts with figures' : `Show every account, to budget one (${hidden} more)`}
        </button>
      )}
      {!data.lines.length ? <Empty title="No income or cost accounts yet" /> : !every && hidden === data.lines.length && <Empty title="Nothing budgeted or in the books for this year or the one before" />}
      {editing && can('reports.view') && <BudgetDrawer line={editing} report={data} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void reload())} />}
    </div>
  );
}

/** One account's twelve months: typed in, spread evenly from a year's total, or copied from last year. */
function BudgetDrawer({ line, report, onClose, onSaved }: { line: Line; report: Report; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [months, setMonths] = useState<(number | null)[]>(line.budget ?? Array(12).fill(null));
  const [year, setYear] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const total = months.reduce<number>((t, m) => t + (m ?? 0), 0);
  const spread = (cents: number) => {
    const each = Math.floor(cents / 12);
    // The odd cents go on the last month, so the twelve add up to the year exactly.
    setMonths(Array.from({ length: 12 }, (_, i) => (i === 11 ? cents - each * 11 : each)));
  };
  const save = async (values: number[]) => {
    setBusy(true);
    try {
      await api('/api/budgets', { method: 'PUT', body: { fyEnd: report.fy.end, lines: [{ accountId: line.id, months: values }] } });
      toast(values.every((v) => v === 0) ? 'Budget cleared' : 'Budget saved');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={line.name}
      sub={`Budget for the year to ${formatDate(report.fy.end)}: ${formatZar(total, { cents: false })}`}
      onClose={onClose}
      footer={
        <div className="row wrap" style={{ gap: 8 }}>
          {line.budget && (
            <button className="btn quiet" disabled={busy} onClick={() => void save(Array(12).fill(0))}>
              Clear the budget
            </button>
          )}
          <span className="grow" />
          <button className="btn primary" disabled={busy} onClick={() => void save(months.map((m) => m ?? 0))}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <div className="row wrap" style={{ gap: 8, alignItems: 'end' }}>
          <Field label="Spread a year’s total evenly">{(p) => <MoneyInput {...p} value={year} onChange={setYear} />}</Field>
          <button className="btn" type="button" disabled={year == null} onClick={() => year != null && spread(year)}>
            Spread
          </button>
          {line.lastYear.some(Boolean) && (
            <button className="btn quiet" type="button" onClick={() => setMonths([...line.lastYear])}>
              Copy last year ({formatZar(sum(line.lastYear), { cents: false })})
            </button>
          )}
        </div>
        <div className="form-grid budget-grid">
          {report.months.map((m, i) => (
            <Field key={m} label={monthLabel(m)} hint={line.lastYear[i] ? `last year ${formatZar(line.lastYear[i]!, { cents: false })}` : undefined}>
              {(p) => <MoneyInput {...p} value={months[i] ?? null} onChange={(c) => setMonths((xs) => xs.map((x, j) => (j === i ? c : x)))} />}
            </Field>
          ))}
        </div>
      </div>
    </Drawer>
  );
}
