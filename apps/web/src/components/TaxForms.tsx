/**
 * SARS forms as Shap can fill them: the VAT201 box by box, and turnover tax for micro businesses.
 * Shap doesn't file: these are the figures to check and type into eFiling (see the SARS guides).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatZar, monthLabel } from '@shap/shared';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { ErrorBox, Loading, Money } from './ui';
import { EstimateNote } from './EstimateNote';

interface Vat201Data {
  category: 'A' | 'B' | 'C';
  registered: boolean;
  vatNumber: string;
  period: { start: string; end: string };
  due: string;
  periods: { start: string; end: string }[];
  fields: Record<string, number>;
}

const periodLabel = (p: { start: string; end: string }) =>
  p.start.slice(0, 7) === p.end.slice(0, 7) ? monthLabel(p.start.slice(0, 7)) : `${monthLabel(p.start.slice(0, 7), false)} to ${monthLabel(p.end.slice(0, 7))}`;

const BOXES: { no: string; label: string; total?: boolean }[] = [
  { no: '1', label: 'Standard-rated supplies (incl. VAT)' },
  { no: '2', label: 'Zero-rated supplies (invoices without VAT)' },
  { no: '3', label: 'Exempt and non-supplies' },
  { no: '4', label: 'Output tax on box 1' },
  { no: '13', label: 'Total output tax', total: true },
  { no: '14', label: 'Input tax: capital goods (assets bought)' },
  { no: '15', label: 'Input tax: other goods and services' },
  { no: '17', label: 'Bad debts written off (the VAT in them)' },
  { no: '19', label: 'Total input tax', total: true },
];

export function Vat201() {
  const [on, setOn] = useState('');
  const { has } = useAuthed();
  const { data, error, reload } = useApi<Vat201Data>(`/api/vat/return${on ? `?on=${on}` : ''}`);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const f = data.fields;
  const payable = f.field20 ?? 0;
  const pending = new Date().toISOString().slice(0, 10) <= data.period.end;
  return (
    <div className="stack narrow-wide">
      <div className="toolbar">
        <select className="select auto" value={data.period.end} onChange={(e) => setOn(e.target.value)} aria-label="VAT period">
          {data.periods.map((p) => (
            <option key={p.end} value={p.end}>
              {periodLabel(p)}
              {new Date().toISOString().slice(0, 10) <= p.end ? ' (still running)' : ''}
            </option>
          ))}
        </select>
        <span className="small muted">
          Category {data.category} · due {formatDate(data.due)} on eFiling
        </span>
      </div>
      <EstimateNote />
      {pending && <div className="banner signal small">This period hasn’t ended yet: the figures will still change.</div>}
      <section className="panel">
        <div className="panel-head spread">
          <strong>VAT201 for {periodLabel(data.period)}</strong>
          {data.vatNumber && <span className="xs muted">VAT {data.vatNumber}</span>}
        </div>
        <div className="sars-boxes">
          {BOXES.map((b) => (
            <div key={b.no} className={`sars-box ${b.total ? 'total' : ''}`}>
              <span className="no">{b.no}</span>
              <span className="small">{b.label}</span>
              <Money cents={f[`field${b.no}`] ?? 0} />
            </div>
          ))}
          <div className="sars-box total">
            <span className="no">20</span>
            <span>{payable >= 0 ? 'VAT payable to SARS' : 'VAT refund from SARS'}</span>
            <strong>
              <Money cents={Math.abs(payable)} />
            </strong>
          </div>
        </div>
      </section>
      <p className="xs muted">
        Invoice basis: issued invoices and credit notes by their dates, and the VAT on costs by the slip’s date. Exports, exempt supplies and imports aren’t split out:
        add those yourself. Box 4 is worked out from box 1 on eFiling; check it matches.{' '}
        {has('guides') && <Link to="/guides/vat201">How to file it, step by step →</Link>}
      </p>
    </div>
  );
}

interface TurnoverData {
  on: boolean;
  fy: { start: string; end: string; label: string };
  asAt: string;
  months: number;
  turnoverCents: number;
  projectedCents: number;
  taxCents: number;
  overLimit: boolean;
  limitCents: number;
  /** A partnership: each partner pays on their own share of the turnover. */
  partners?: { name: string; shareBp: number; turnoverCents: number; taxCents: number }[];
  bands: [number, number, number][];
  interim: { label: string; due: string; cents: number }[];
}

export function TurnoverTax() {
  const { has } = useAuthed();
  const { data, error, reload } = useApi<TurnoverData>('/api/reports/turnover-tax');
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const rand = (r: number) => formatZar(r * 100, { cents: false });
  return (
    <div className="stack narrow-wide">
      {data.overLimit && (
        <div className="banner alert small">
          At this pace the year’s turnover is over {formatZar(data.limitCents, { cents: false })}: turnover tax stops applying. Talk to your accountant about moving back to
          income tax (SARS must be told within 21 days of exceeding the limit).
        </div>
      )}
      <EstimateNote />
      <section className="panel panel-pad stack">
        <h3>Turnover tax, {data.fy.label}</h3>
        <div className="kpis compact">
          <div className="kpi">
            <div className="xs muted">Turnover so far ({data.months} month{data.months === 1 ? '' : 's'})</div>
            <strong>
              <Money cents={data.turnoverCents} whole />
            </strong>
          </div>
          <div className="kpi">
            <div className="xs muted">The year at this pace</div>
            <strong>
              <Money cents={data.projectedCents} whole />
            </strong>
          </div>
          <div className="kpi">
            <div className="xs muted">Turnover tax on that</div>
            <strong>
              <Money cents={data.taxCents} whole />
            </strong>
          </div>
        </div>
        {data.partners && data.partners.length > 0 && (
          <ul className="list">
            {data.partners.map((p) => (
              <li key={p.name} className="list-row">
                <span className="grow small">
                  {p.name} ({(p.shareBp / 100).toLocaleString('en-ZA')}%)
                  <div className="xs muted">Turnover share <Money cents={p.turnoverCents} whole />: each partner registers and pays on their own share</div>
                </span>
                <Money cents={p.taxCents} whole />
              </li>
            ))}
          </ul>
        )}
        <ul className="list">
          {data.interim.map((i) => (
            <li key={i.label} className="list-row">
              <span className="grow small">
                {i.label}
                <div className="xs muted">Due {formatDate(i.due)} (TT02, paid on eFiling)</div>
              </span>
              <Money cents={i.cents} whole />
            </li>
          ))}
        </ul>
        <p className="xs muted">
          Turnover is all business income, not profit: costs don’t reduce it. The projection takes the months so far and stretches them to a year; change what you pay
          if you know the rest of the year will be different. The annual return (TT03) settles the actual figure.
        </p>
      </section>
      <section className="panel">
        <div className="panel-head strong">SARS’s table for this year</div>
        <table className="table compact">
          <tbody>
            {data.bands.map(([from, base, rate], i) => {
              const next = data.bands[i + 1];
              return (
                <tr key={from}>
                  <td>
                    {rand(from)}
                    {next ? ` to ${rand(next[0])}` : ' and over'}
                  </td>
                  <td>{rate === 0 ? 'Nothing' : `${base ? `${rand(base)} + ` : ''}${Math.round(rate * 1000) / 10}% of the amount over ${rand(from)}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {has('guides') && (
        <p className="small">
          <Link to="/guides/turnover">How turnover tax works and how to pay it, step by step →</Link>
        </p>
      )}
    </div>
  );
}
