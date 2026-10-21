import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatZar, monthEnd, monthLabel } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { CostForm, type CostDraft } from './CostForm';
import { Drawer, Empty, ErrorBox, Loading, useToast } from './ui';

interface Recurring {
  key: string;
  label: string;
  supplier: string;
  description: string;
  categoryId: string;
  categoryName: string;
  sourceId: string | null;
  usualCents: number;
  usualDay: number;
  lastSeen: string;
  months: { month: string; cents: number; skipped: boolean }[];
  status: 'ok' | 'due' | 'missing' | 'stopped';
  missingMonths: string[];
  onStatement: { lineId: string; sourceId: string; date: string; description: string; amountCents: number } | null;
}

const STATUS: Record<Recurring['status'], { text: string; chip: string }> = {
  missing: { text: 'missing', chip: 'warn' },
  due: { text: 'due soon', chip: '' },
  ok: { text: 'in', chip: 'ok' },
  stopped: { text: 'not watched', chip: '' },
};

/** The usual day in that month (the 31st becomes the month's last day). */
const dayIn = (month: string, day: number) => {
  const last = Number(monthEnd(`${month}-01`).slice(8, 10));
  return `${month}-${String(Math.min(Math.max(day, 1), last)).padStart(2, '0')}`;
};

/**
 * Costs that come every month (insurance, bank fees, subscriptions), learnt from what you've
 * captured. One that doesn't show up is flagged here and on Home until it's captured, skipped
 * for that month, or marked as stopped.
 */
export function RecurringCosts() {
  const { isOwner } = useAuthed();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Recurring[]>('/api/costs/recurring');
  const [adding, setAdding] = useState<{ r: Recurring; month: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (path: 'mark' | 'unmark', body: { key: string; month?: string }, done: string) => {
    setBusy(true);
    try {
      await api(`/api/costs/recurring/${path}`, { body });
      toast(done);
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save that', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data?.length)
    return (
      <div className="panel">
        <Empty title="No monthly costs yet">Once a running cost (insurance, bank fees, a subscription) has come three months in a row, it shows here.</Empty>
      </div>
    );
  const draft = (r: Recurring, month: string): CostDraft => ({
    date: dayIn(month, r.usualDay),
    description: r.description,
    amountCents: r.usualCents,
    vatCents: 0,
    supplier: r.supplier,
    categoryId: r.categoryId,
    sourceId: r.sourceId,
    projectId: null,
    plannedItemId: null,
    receiptId: null,
    note: '',
  });

  return (
    <div className="stack">
      <p className="small muted">
        Running costs that came every month for at least three months. When one doesn’t show up, it’s flagged here and on Home: capture it, skip that
        month, or stop watching it (a cancelled policy or subscription).
      </p>
      <div className="panel table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Cost</th>
              <th className="num">Usually</th>
              {data[0]!.months.map((m) => (
                <th key={m.month} className="num hide-md">
                  {monthLabel(m.month, false)}
                </th>
              ))}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.key} className={r.status === 'stopped' ? 'inactive' : ''}>
                <td className="small">
                  <strong>{r.label}</strong>
                  <div className="xs muted">
                    {r.categoryName} · around the {r.usualDay}
                    {[1, 21, 31].includes(r.usualDay) ? 'st' : [2, 22].includes(r.usualDay) ? 'nd' : [3, 23].includes(r.usualDay) ? 'rd' : 'th'}
                  </div>
                </td>
                <td className="num nowrap">{formatZar(r.usualCents)}</td>
                {r.months.map((m) => (
                  <td key={m.month} className={`num xs nowrap hide-md ${r.missingMonths.includes(m.month) ? 'warn-text' : 'muted'}`}>
                    {m.cents ? formatZar(m.cents, { cents: false }) : m.skipped ? 'skipped' : r.missingMonths.includes(m.month) ? 'missing' : '–'}
                  </td>
                ))}
                <td className="small">
                  <span className={`chip ${STATUS[r.status].chip}`}>{STATUS[r.status].text}</span>
                  {r.status === 'missing' && (
                    <div className="xs" style={{ marginTop: 4 }}>
                      {r.missingMonths.map((m) => monthLabel(m)).join(', ')}
                      {r.onStatement && (
                        <>
                          {' '}
                          · on the statement {formatDate(r.onStatement.date)},{' '}
                          <Link to={`/accounts?tab=bank&source=${r.onStatement.sourceId}`}>not captured yet</Link>
                        </>
                      )}
                    </div>
                  )}
                  {isOwner && (
                    <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                      {r.status === 'missing' && !r.onStatement && (
                        <button className="btn small" disabled={busy} onClick={() => setAdding({ r, month: r.missingMonths[0]! })}>
                          Add {monthLabel(r.missingMonths[0]!, false)}’s
                        </button>
                      )}
                      {r.status === 'missing' && (
                        <button className="btn quiet small" disabled={busy} onClick={() => void act('mark', { key: r.key, month: r.missingMonths[0]! }, `${monthLabel(r.missingMonths[0]!)} skipped`)}>
                          Skip {monthLabel(r.missingMonths[0]!, false)}
                        </button>
                      )}
                      {r.status === 'stopped' ? (
                        <button className="btn quiet small" disabled={busy} onClick={() => void act('unmark', { key: r.key }, 'Watching it again')}>
                          Watch again
                        </button>
                      ) : (
                        <button className="btn quiet small" disabled={busy} onClick={() => void act('mark', { key: r.key }, 'Not watched any more')} title="Cancelled, or not really monthly: don’t expect it any more">
                          Stop watching
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <Drawer title={`${adding.r.label}: ${monthLabel(adding.month)}`} onClose={() => setAdding(null)}>
          <CostForm
            initial={draft(adding.r, adding.month)}
            onSaved={() => {
              setAdding(null);
              void reload();
            }}
          />
        </Drawer>
      )}
    </div>
  );
}
