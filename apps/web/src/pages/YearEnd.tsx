import { useEffect, useMemo, useState } from 'react';
import { ACCOUNT_TYPE_LABELS, addMonths, companyTax, financialYear, formatAmount, formatDate, formatZar, sbcTableFor, todayIso, type AccountType } from '@shap/shared';
import { ErrorBox, Icon, Loading, MoneyInput, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';

const fmt = (c: number) => (c === 0 ? '–' : formatAmount(c));

/* ================================================================ year end */
interface YearEndForm {
  fyEnd: string;
  fyStart: string;
  label: string;
  agreed: boolean;
  note: string;
  openingRetainedCents: number;
  rows: { id: string; code: string; name: string; type: AccountType; shapCents: number; targetCents: number | null }[];
  allAccounts: { id: string; code: string; name: string; type: AccountType }[];
}
interface YearEndRow {
  fyEnd: string;
  note: string;
  figures: number;
  suspenseCents: number;
}

const ORDER: AccountType[] = ['asset', 'liability', 'equity', 'income', 'cost_of_sales', 'expense'];

/**
 * The accountant's signed-off figures for a year. Shap keeps its own detail (every invoice,
 * slip and wage) and posts one adjustment per account at the year end so the statements match
 * the accountant's; next year starts from the agreed balances.
 */
export function YearEnd() {
  const { settings, isOwner } = useAuthed();
  const toast = useToast();
  const today = todayIso();
  const thisFy = financialYear(today, settings.fyEndMonth);
  const fys = [1, 2, 3, 4, 5].map((n) => financialYear(addMonths(thisFy.start, -12 * n), settings.fyEndMonth));
  const list = useApi<YearEndRow[]>('/api/year-ends');
  const [fyEnd, setFyEnd] = useState(fys[0]!.end);
  const form = useApi<YearEndForm>(`/api/year-ends/form?fyEnd=${fyEnd}`);
  const [targets, setTargets] = useState<Record<string, number | null>>({});
  const [extra, setExtra] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [lock, setLock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!form.data) return;
    setTargets(Object.fromEntries(form.data.rows.map((r) => [r.id, r.targetCents])));
    setExtra([]);
    setNote(form.data.note);
    setError('');
  }, [form.data]);

  const rows = useMemo(() => {
    if (!form.data) return [];
    const have = new Set(form.data.rows.map((r) => r.id));
    const added = form.data.allAccounts.filter((a) => extra.includes(a.id) && !have.has(a.id)).map((a) => ({ ...a, shapCents: 0, targetCents: null }));
    return [...form.data.rows, ...added].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.code.localeCompare(b.code));
  }, [form.data, extra]);

  const entered = rows.filter((r) => targets[r.id] != null);
  const sumType = (types: AccountType[], pick: (r: (typeof rows)[number]) => number) => rows.filter((r) => types.includes(r.type)).reduce((s, r) => s + pick(r), 0);
  const target = (r: (typeof rows)[number]) => targets[r.id] ?? r.shapCents;
  const profit = (pick: (r: (typeof rows)[number]) => number) => sumType(['income'], pick) - sumType(['cost_of_sales', 'expense'], pick);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/year-ends', {
        method: 'PUT',
        body: { fyEnd, note, lock, figures: entered.map((r) => ({ accountId: r.id, amountCents: targets[r.id]! })) },
      });
      toast(`Year end ${formatDate(fyEnd)} agreed`);
      await Promise.all([form.reload(), list.reload()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm('Remove the accountant’s figures for this year? The books go back to Shap’s own detail.')) return;
    await api(`/api/year-ends/${fyEnd}`, { method: 'DELETE' });
    toast('Year end removed');
    await Promise.all([form.reload(), list.reload()]);
  };

  const agreedRow = list.data?.find((y) => y.fyEnd === fyEnd);
  const addable = form.data?.allAccounts.filter((a) => !rows.some((r) => r.id === a.id)) ?? [];

  return (
    <div className="stack-lg">
      <section className="panel panel-pad stack">
        <p className="small">
          Type in the figures from the accountant’s annual financial statements. Shap keeps its own detail and posts one adjustment per account on the last
          day of the year, so the income statement and balance sheet for that year match the statements, and next year opens from the agreed balances.
          Accounts you leave blank keep Shap’s figure. Whatever doesn’t tie up goes to <em>Suspense</em>, so you can see it.
        </p>
        <div className="toolbar wrap">
          <select className="select auto" value={fyEnd} onChange={(e) => setFyEnd(e.target.value)} aria-label="Financial year">
            {fys.map((f) => (
              <option key={f.end} value={f.end}>
                {f.label} (year ended {formatDate(f.end)}){list.data?.some((y) => y.fyEnd === f.end) ? ' ✓ agreed' : ''}
              </option>
            ))}
          </select>
          {agreedRow && (
            <span className={`chip ${agreedRow.suspenseCents ? 'warn' : 'ok'}`}>
              {agreedRow.figures} accounts agreed{agreedRow.suspenseCents ? ` · ${formatZar(Math.abs(agreedRow.suspenseCents))} to suspense` : ' · ties up'}
            </span>
          )}
        </div>
      </section>
      <ErrorBox error={form.error ?? list.error} onRetry={form.reload} />
      {!form.data ? (
        <Loading />
      ) : (
        <>
          <section className="panel table-wrap">
            <table className="table statement year-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="num">Shap</th>
                  <th className="num">Accountant</th>
                  <th className="num hide-sm">Difference</th>
                </tr>
              </thead>
              {ORDER.map((type) => {
                const group = rows.filter((r) => r.type === type);
                if (!group.length) return null;
                return (
                  <tbody key={type}>
                    <tr className="group">
                      <th colSpan={4}>{ACCOUNT_TYPE_LABELS[type]}</th>
                    </tr>
                    {group.map((r) => {
                      const t = targets[r.id];
                      const diff = t == null ? 0 : t - r.shapCents;
                      return (
                        <tr key={r.id} className={diff ? 'off' : ''}>
                          <td>
                            <span className="code">{r.code}</span> {r.name}
                          </td>
                          <td className="num">{fmt(r.shapCents)}</td>
                          <td className="num">
                            {isOwner ? (
                              <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                                <MoneyInput value={t ?? null} allowNegative placeholder="Shap’s" onChange={(c) => setTargets((x) => ({ ...x, [r.id]: c }))} aria-label={`Accountant’s figure for ${r.name}`} />
                                {t == null && r.shapCents !== 0 && (
                                  <button type="button" className="btn quiet small icon" title="Use Shap’s figure" aria-label={`Use Shap’s figure for ${r.name}`} onClick={() => setTargets((x) => ({ ...x, [r.id]: r.shapCents }))}>
                                    <Icon name="check" size={14} />
                                  </button>
                                )}
                              </div>
                            ) : (
                              fmt(t ?? r.shapCents)
                            )}
                          </td>
                          <td className="num hide-sm">{diff ? formatAmount(diff) : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
              <tbody>
                <tr className="grand">
                  <td>Net profit (loss) for the year</td>
                  <td className="num">{formatAmount(profit((r) => r.shapCents))}</td>
                  <td className="num">{formatAmount(profit(target))}</td>
                  <td className="num hide-sm">{profit(target) - profit((r) => r.shapCents) ? formatAmount(profit(target) - profit((r) => r.shapCents)) : ''}</td>
                </tr>
              </tbody>
            </table>
          </section>
          {isOwner && (
            <section className="panel panel-pad stack">
              {addable.length > 0 && (
                <div className="row wrap">
                  <span className="small grow">An account on the statements that isn’t listed?</span>
                  <select className="select auto" value="" onChange={(e) => e.target.value && setExtra((x) => [...x, e.target.value])} aria-label="Add an account">
                    <option value="">Add an account…</option>
                    {addable.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <label className="field">
                <span className="label">Note</span>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. AFS signed 30 Sep 2025, prepared by …" />
              </label>
              <label className="check">
                <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
                <span>
                  Lock the year
                  <div className="xs muted">Nothing dated on or before {formatDate(fyEnd)} can be changed afterwards, so the agreed figures stay agreed.</div>
                </span>
              </label>
              <p className="xs muted">
                Saving also removes the opening journal the tracker import made for this year or earlier: the accountant’s figures replace it.
              </p>
              {error && <div className="banner alert small">{error}</div>}
              <div className="row wrap">
                <button className="btn primary big grow" disabled={busy || !entered.length} onClick={() => void save()}>
                  {busy ? 'Saving…' : `Agree ${entered.length} account${entered.length === 1 ? '' : 's'}`}
                </button>
                {form.data.agreed && (
                  <button className="btn quiet" onClick={() => void remove()}>
                    Remove
                  </button>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* ================================================================ provisional tax */
interface TaxLine {
  accountId: string;
  code: string;
  name: string;
  type: 'income' | 'cost_of_sales' | 'expense';
  actualCents: number;
  projectedCents: number;
  priorCents: number;
}
interface TaxData {
  fy: { start: string; end: string; label: string };
  prev: { start: string; end: string; label: string };
  asAt: string;
  months: number;
  lines: TaxLine[];
  assessedLossCents: number;
  saved: { id: string; period: number; asAt: string; taxableIncomeCents: number; taxCents: number; payableCents: number; note: string; createdAt: string }[];
}

/**
 * A provisional tax estimate (IRP6) laid out the way the accountant does it: this year so far,
 * projected to twelve months, against last year; then the SBC tax table. Every projected figure
 * can be overridden before it's saved.
 */
export function ProvisionalTax() {
  const { settings, isOwner } = useAuthed();
  const toast = useToast();
  const today = todayIso();
  const thisFy = financialYear(today, settings.fyEndMonth);
  const choices = [thisFy, financialYear(addMonths(thisFy.start, -12), settings.fyEndMonth)];
  const [fyEnd, setFyEnd] = useState(thisFy.end);
  const [asAt, setAsAt] = useState('');
  const { data, error, reload } = useApi<TaxData>(`/api/reports/provisional-tax?fyEnd=${fyEnd}${asAt ? `&asAt=${asAt}` : ''}`);
  const [proj, setProj] = useState<Record<string, number>>({});
  const [loss, setLoss] = useState(0);
  const [sbc, setSbc] = useState(true);
  const [period, setPeriod] = useState(1);
  const [paid, setPaid] = useState(0);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!data) return;
    setProj(Object.fromEntries(data.lines.map((l) => [l.accountId, l.projectedCents])));
    setLoss(data.assessedLossCents);
    // First period runs to the half-year; after that it's the second.
    setPeriod(data.months <= 6 ? 1 : 2);
  }, [data]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const p = (l: TaxLine) => proj[l.accountId] ?? l.projectedCents;
  const of = (type: TaxLine['type'], pick: (l: TaxLine) => number) => data.lines.filter((l) => l.type === type).reduce((s, l) => s + pick(l), 0);
  const cols = [(l: TaxLine) => l.priorCents, (l: TaxLine) => l.actualCents, p];
  const totals = cols.map((pick) => {
    const income = of('income', pick);
    const cos = of('cost_of_sales', pick);
    const exp = of('expense', pick);
    return { income, cos, gross: income - cos, exp, net: income - cos - exp };
  });
  const net = totals[2]!.net;
  const taxable = Math.max(0, net - loss);
  const tax = companyTax(taxable, data.fy.end, sbc);
  const due = period === 1 ? Math.round(tax / 2) : tax;
  const payable = Math.max(0, due - (period === 1 ? 0 : paid));
  const bands = sbcTableFor(data.fy.end);

  const save = async () => {
    try {
      await api('/api/tax-estimates', {
        body: {
          fyEnd: data.fy.end,
          period,
          asAt: data.asAt,
          note,
          sbc,
          assessedLossCents: loss,
          paidCents: period === 1 ? 0 : paid,
          lines: data.lines.map((l) => ({ accountId: l.accountId, name: l.name, type: l.type, actualCents: l.actualCents, projectedCents: p(l) })),
        },
      });
      toast('Estimate saved');
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save', 'error');
    }
  };

  const section = (title: string, type: TaxLine['type']) => {
    const lines = data.lines.filter((l) => l.type === type);
    if (!lines.length) return null;
    return (
      <>
        <tr className="subgroup">
          <td colSpan={4}>{title}</td>
        </tr>
        {lines.map((l) => (
          <tr key={l.accountId}>
            <td>{l.name}</td>
            <td className="num hide-sm">{fmt(l.priorCents)}</td>
            <td className="num">{fmt(l.actualCents)}</td>
            <td className="num">
              {isOwner ? (
                <span className="no-print-input">
                  <MoneyInput value={p(l)} allowNegative onChange={(c) => setProj((x) => ({ ...x, [l.accountId]: c ?? 0 }))} aria-label={`Projected ${l.name}`} />
                </span>
              ) : (
                fmt(p(l))
              )}
            </td>
          </tr>
        ))}
      </>
    );
  };
  const totalRow = (label: string, k: keyof (typeof totals)[number], cls = 'sub') => (
    <tr className={cls}>
      <td>{label}</td>
      <td className="num hide-sm">{formatAmount(totals[0]![k])}</td>
      <td className="num">{formatAmount(totals[1]![k])}</td>
      <td className="num">{formatAmount(totals[2]![k])}</td>
    </tr>
  );

  return (
    <div className="stack-lg">
      <section className="panel panel-pad stack no-print">
        <p className="small">
          Shap takes this year’s figures to date, projects them to twelve months at the same monthly rate, and works out the tax on the small business
          corporation table. Change any projected figure (a big job you know is coming, a cost that won’t repeat) before saving. Your accountant still files
          the IRP6; this gets you the number to talk about.
        </p>
        <div className="toolbar wrap">
          <select className="select auto" value={fyEnd} onChange={(e) => (setFyEnd(e.target.value), setAsAt(''))} aria-label="Year of assessment">
            {choices.map((f) => (
              <option key={f.end} value={f.end}>
                Year ending {formatDate(f.end)} ({f.label})
              </option>
            ))}
          </select>
          <label className="row small">
            Figures to
            <input className="input auto" type="date" value={asAt || data.asAt} min={data.fy.start} max={data.fy.end} onChange={(e) => setAsAt(e.target.value)} />
          </label>
          <button className="btn quiet" onClick={() => window.print()}>
            <Icon name="print" size={18} />
            Print
          </button>
        </div>
      </section>

      <section className="panel table-wrap">
        <div className="panel-head">
          <strong>Provisional tax estimate · year ending {formatDate(data.fy.end, 'long')}</strong>
          <div className="xs muted">
            {settings.companyName}
            {settings.regNumber ? ` · ${settings.regNumber}` : ''} · actual to {formatDate(data.asAt)} ({data.months} month{data.months === 1 ? '' : 's'})
          </div>
        </div>
        <table className="table statement tax-sheet">
          <thead>
            <tr>
              <th />
              <th className="num hide-sm">{data.prev.label} actual</th>
              <th className="num">To {formatDate(data.asAt)}</th>
              <th className="num">Full year (est.)</th>
            </tr>
          </thead>
          <tbody>
            {section('Revenue', 'income')}
            {totalRow('Total revenue', 'income')}
            {section('Cost of sales', 'cost_of_sales')}
            {totalRow('Gross profit', 'gross')}
            {section('Expenses', 'expense')}
            {totalRow('Total expenses', 'exp')}
            {totalRow('Net profit (loss) before tax', 'net', 'total')}
          </tbody>
        </table>
      </section>

      <section className="panel panel-pad stack narrow-wide">
        <h3>Tax</h3>
        <table className="table tax-sheet">
          <tbody>
            <tr>
              <td>Estimated net profit</td>
              <td className="num">{formatZar(net)}</td>
            </tr>
            <tr>
              <td>
                Less: assessed loss brought forward
                <div className="xs muted">From earlier years in the books; check it against last year’s assessment (ITA34).</div>
              </td>
              <td className="num">{isOwner ? <MoneyInput value={loss} onChange={(c) => setLoss(c ?? 0)} aria-label="Assessed loss brought forward" /> : formatZar(loss)}</td>
            </tr>
            <tr className="sub">
              <td>Taxable income</td>
              <td className="num">{formatZar(taxable)}</td>
            </tr>
            <tr>
              <td>
                <label className="check">
                  <input type="checkbox" checked={sbc} onChange={(e) => setSbc(e.target.checked)} />
                  <span>
                    Small business corporation rates
                    <div className="xs muted">
                      {sbc
                        ? bands.map((b, i) => (i === 0 ? `0% to R${b.upTo!.toLocaleString('en-ZA')}` : `${Math.round(b.rate * 100)}% above R${b.over.toLocaleString('en-ZA')}`)).join(', ')
                        : 'Flat 27% company rate'}
                    </div>
                  </span>
                </label>
              </td>
              <td className="num">{formatZar(tax)}</td>
            </tr>
            <tr>
              <td>
                <div className="row wrap">
                  <span>Period</span>
                  <select className="select auto" value={period} onChange={(e) => setPeriod(Number(e.target.value))} aria-label="Period">
                    <option value={1}>1st (half the year’s tax)</option>
                    <option value={2}>2nd (the full year’s tax, less the 1st)</option>
                    <option value={3}>3rd (top-up)</option>
                  </select>
                </div>
              </td>
              <td className="num">{formatZar(due)}</td>
            </tr>
            {period > 1 && (
              <tr>
                <td>Less: paid in earlier periods</td>
                <td className="num">{isOwner ? <MoneyInput value={paid} onChange={(c) => setPaid(c ?? 0)} aria-label="Already paid" /> : formatZar(paid)}</td>
              </tr>
            )}
            <tr className="total">
              <td>Payable this period</td>
              <td className="num">{formatZar(payable)}</td>
            </tr>
          </tbody>
        </table>
        <p className="xs muted">
          Rates from SARS for years of assessment ending {data.fy.end >= '2026-04-01' ? 'on or after 1 April 2026' : '1 April 2023 to 31 March 2026'}.
        </p>
        {isOwner && (
          <div className="stack no-print">
            <label className="field">
              <span className="label">Note</span>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Sent to accountant 20 Aug" />
            </label>
            <button className="btn primary" onClick={() => void save()}>
              Save this estimate
            </button>
          </div>
        )}
      </section>

      {data.saved.length > 0 && (
        <section className="panel no-print">
          <div className="panel-head">
            <strong>Saved estimates for this year</strong>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Saved</th>
                  <th>Period</th>
                  <th className="num">Taxable</th>
                  <th className="num">Tax</th>
                  <th className="num">Payable</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.saved.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {formatDate(s.createdAt.slice(0, 10))}
                      <div className="xs muted">
                        figures to {formatDate(s.asAt)}
                        {s.note ? ` · ${s.note}` : ''}
                      </div>
                    </td>
                    <td>{s.period}</td>
                    <td className="num">{formatAmount(s.taxableIncomeCents)}</td>
                    <td className="num">{formatAmount(s.taxCents)}</td>
                    <td className="num strong">{formatAmount(s.payableCents)}</td>
                    <td>
                      {isOwner && (
                        <button className="btn quiet small" onClick={() => void api(`/api/tax-estimates/${s.id}`, { method: 'DELETE' }).then(reload)} aria-label="Delete estimate">
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
