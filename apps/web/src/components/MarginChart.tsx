import { useState } from 'react';
import { formatPercent } from '@shap/shared';

/** A month's gross margin: what's left of each rand of revenue after the cost of the sales (the income statement's gross profit). */
export interface MarginPoint {
  key: string;
  label: string;
  incomeCents: number;
  costOfSalesCents: number;
}

export const marginOf = (m: MarginPoint): number | null => (m.incomeCents > 0 ? (m.incomeCents - m.costOfSalesCents) / m.incomeCents : null);

/**
 * Gross margin month by month: one series, one axis from 0% to 100% (a month that lost money on
 * its sales shows at 0, with its figure in the table). A month with nothing invoiced has no bar.
 */
export function MarginChart({ data, title = 'Gross margin, month by month' }: { data: MarginPoint[]; title?: string }) {
  const [table, setTable] = useState(false);
  const W = 640;
  const H = 170;
  const pad = { l: 40, r: 8, t: 16, b: 26 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const slot = plotW / Math.max(1, data.length);
  const barW = Math.min(22, slot - 10);
  const y = (v: number) => pad.t + plotH - Math.min(1, Math.max(0, v)) * plotH;
  const margins = data.map(marginOf);
  const known = margins.filter((m): m is number => m != null);
  const revenue = data.reduce((t, d) => t + d.incomeCents, 0);
  // Over the 12 months: none when there was no revenue to measure against.
  const average = known.length && revenue > 0 ? data.reduce((t, d) => t + d.incomeCents - d.costOfSalesCents, 0) / revenue : null;

  return (
    <figure className="chart">
      <div className="spread chart-head">
        <figcaption className="strong">{title}</figcaption>
        <div className="row small">
          {average != null && <span className="muted">12 months: {formatPercent(average)}</span>}
          <button className="btn quiet small" onClick={() => setTable(!table)} aria-pressed={table}>
            {table ? 'Chart' : 'Table'}
          </button>
        </div>
      </div>
      {table ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Gross margin</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d, i) => (
                <tr key={d.key}>
                  <td>{d.label}</td>
                  <td className="num">{margins[i] == null ? '–' : formatPercent(margins[i]!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 'auto' }} role="img" aria-label={`${title}: ${data.map((d, i) => `${d.label} ${margins[i] == null ? 'nothing invoiced' : formatPercent(margins[i]!)}`).join(', ')}`}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
              <text className="axis" x={pad.l - 6} y={y(t) + 4} textAnchor="end">
                {Math.round(t * 100)}%
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const m = margins[i];
            const x = pad.l + i * slot + (slot - barW) / 2;
            return (
              <g key={d.key}>
                {m != null && m > 0 && <rect className="b1" x={x} y={y(m)} width={barW} height={pad.t + plotH - y(m)} rx={3} />}
                {m != null && (
                  <text className="axis" x={x + barW / 2} y={y(Math.max(0, m)) - 4} textAnchor="middle">
                    {Math.round(m * 100)}
                  </text>
                )}
                <text className="axis" x={x + barW / 2} y={H - 8} textAnchor="middle">
                  {d.label.slice(0, 3)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <p className="xs muted">Revenue less cost of sales, as a share of revenue, from what’s captured: the income statement’s gross profit, month by month.</p>
    </figure>
  );
}
