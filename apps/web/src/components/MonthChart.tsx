import { useState } from 'react';
import { formatZar } from '@shap/shared';

export interface MonthPoint {
  key: string;
  label: string;
  incomeCents: number;
  costsCents: number;
}

const short = (cents: number) => {
  const r = cents / 100;
  if (Math.abs(r) >= 1_000_000) return `R${(r / 1_000_000).toFixed(1)}m`;
  if (Math.abs(r) >= 1000) return `R${Math.round(r / 1000)}k`;
  return `R${Math.round(r)}`;
};

function niceMax(v: number) {
  if (v <= 0) return 100_00;
  const exp = 10 ** Math.floor(Math.log10(v));
  const n = v / exp;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * exp;
}

/**
 * Income against costs per month: two series, grouped bars, one axis.
 * Colours come from --series-1 / --series-2 (validated for colour-blind separation in both themes).
 */
export function MonthChart({ data, title = 'Income and costs by month' }: { data: MonthPoint[]; title?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 640;
  const H = 220;
  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.incomeCents, d.costsCents)), 0));
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const slot = plotW / Math.max(1, data.length);
  const barW = Math.min(18, (slot - 10) / 2);
  const y = (v: number) => pad.t + plotH - (Math.max(0, v) / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const bar = (x: number, v: number, cls: string) => {
    const top = y(v);
    const h = pad.t + plotH - top;
    if (h <= 0) return null;
    const r = Math.min(4, h, barW / 2);
    // Rounded data-end, square at the baseline.
    return <path className={cls} d={`M${x},${pad.t + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${pad.t + plotH} Z`} />;
  };
  const h = hover != null ? data[hover] : null;

  return (
    <figure className="chart">
      <div className="spread chart-head">
        <figcaption className="strong">{title}</figcaption>
        <div className="row small">
          <span className="legend-item">
            <span className="swatch s1" />
            Income
          </span>
          <span className="legend-item">
            <span className="swatch s2" />
            Costs
          </span>
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
                <th className="num">Income</th>
                <th className="num">Costs</th>
                <th className="num">Profit</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.key}>
                  <td>{d.label}</td>
                  <td className="num">{formatZar(d.incomeCents, { cents: false })}</td>
                  <td className="num">{formatZar(d.costsCents, { cents: false })}</td>
                  <td className="num">{formatZar(d.incomeCents - d.costsCents, { cents: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} preserveAspectRatio="none" style={{ width: '100%', height: 'auto' }}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
                <text x={pad.l - 6} y={y(t) + 4} className="axis" textAnchor="end">
                  {short(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x0 = pad.l + i * slot + (slot - (barW * 2 + 2)) / 2;
              return (
                <g key={d.key}>
                  {hover === i && <rect x={pad.l + i * slot} y={pad.t} width={slot} height={plotH} className="hover-band" />}
                  {bar(x0, d.incomeCents, 'b1')}
                  {bar(x0 + barW + 2, d.costsCents, 'b2')}
                  <text x={pad.l + i * slot + slot / 2} y={H - 8} className="axis" textAnchor="middle">
                    {d.label.split(' ')[0]}
                  </text>
                  <rect x={pad.l + i * slot} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
          {h && (
            <div className="tooltip" style={{ left: `${((pad.l + (hover! + 0.5) * slot) / W) * 100}%` }}>
              <strong>{h.label}</strong>
              <div className="row">
                <span className="swatch s1" />
                Income <span className="grow" />
                {formatZar(h.incomeCents, { cents: false })}
              </div>
              <div className="row">
                <span className="swatch s2" />
                Costs <span className="grow" />
                {formatZar(h.costsCents, { cents: false })}
              </div>
              <div className="row strong">
                Profit <span className="grow" />
                {formatZar(h.incomeCents - h.costsCents, { cents: false })}
              </div>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
