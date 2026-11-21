import { useState } from 'react';
import { formatDate, formatZar, offCashNote } from '@shap/shared';
import { Empty, ErrorBox, Kpi, Loading, Money } from '../components/ui';
import { useApi } from '../lib/hooks';

interface ForecastItem {
  week: number;
  date: string;
  label: string;
  cents: number;
  kind: string;
}
interface Forecast {
  asOf: string;
  openingCents: number;
  cardsOweCents: number;
  offCash?: { name: string; cents: number }[];
  weeks: { start: string; end: string; inCents: number; outCents: number; closingCents: number }[];
  items: ForecastItem[];
  lowest: { week: number; closingCents: number } | null;
  longOverdue: { count: number; cents: number; days: number };
  leavingAhead?: boolean;
}

/** What the forecast is, and isn't: said where it's shown. */
export const FORECAST_NOTE =
  'An estimate from what’s in your books today: the cash as your statements count it; invoices on their due dates (overdue ones this week, as if paid now); supplier bills on theirs; what’s already in the books for a day to come; salaries and the EMP201 as your recent pay runs (the employment tax incentive isn’t taken off); wages owed now; dividends (or distributions) declared and not paid yet, all this week, as if paid in full now (any dividends tax on them included); dividends tax already withheld, on its DTR01 date; day wages at their recent average; VAT as invoiced (the invoice basis) on each VAT201; and the costs you usually pay each month. Sales you haven’t made or invoiced yet aren’t in it, nor are provisional or turnover tax, drawings, or card and loan repayments; and clients pay late and new costs come. An aid to plan with, not advice: OpenWorks IT, who make Shap, aren’t accountants or tax practitioners.';

/** For someone who doesn't see payroll: the salaries aren't cut for leaving dates still to come. */
export const LEAVING_NOTE = 'The salaries here are as if no one leaves who hasn’t left yet: leaving dates still to come are for those who see payroll.';

/**
 * The next 13 weeks of money in and out, week by week, from what's in the books (forecast.ts on
 * the server). Tap a week for what's in it.
 */
export function CashForecast() {
  const { data, error, loading, reload } = useApi<Forecast>('/api/forecast');
  const [open, setOpen] = useState<number | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const low = data.lowest;
  return (
    <div className="stack-lg">
      <div className="kpis">
        <Kpi label="In the bank and till now" value={<Money cents={data.openingCents} whole />} sub={data.cardsOweCents > 0 ? `cards owe ${formatZar(data.cardsOweCents, { cents: false })} (not in the weeks below)` : formatDate(data.asOf)} />
        <Kpi label="In 13 weeks" value={<Money cents={data.weeks[data.weeks.length - 1]?.closingCents ?? data.openingCents} whole />} sub="an estimate, if clients pay what they owe now and costs run as usual" />
        {low && (
          <Kpi
            label="Lowest point"
            value={<Money cents={low.closingCents} whole />}
            sub={`the week of ${formatDate(data.weeks[low.week]!.start)}`}
            tone={low.closingCents < 0 ? 'bad' : low.closingCents < data.openingCents / 4 ? 'warn' : undefined}
          />
        )}
      </div>
      {data.longOverdue.count > 0 && (
        <p className="small">
          Not counted as coming in: {data.longOverdue.count} invoice{data.longOverdue.count === 1 ? '' : 's'} more than {data.longOverdue.days} days overdue ({formatZar(data.longOverdue.cents, { cents: false })}). Whether they’ll be paid is yours to judge.
        </p>
      )}
      {offCashNote(data.offCash, (c) => formatZar(c, { cents: false })) && <p className="small warn-text">{offCashNote(data.offCash, (c) => formatZar(c, { cents: false }))}</p>}
      {data.leavingAhead === false && <p className="xs muted">{LEAVING_NOTE}</p>}
      <p className="xs muted">{FORECAST_NOTE}</p>
      <div className="panel table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Week of</th>
              <th className="num hide-sm">Money in</th>
              <th className="num hide-sm">Money out</th>
              <th className="num">At the week’s end</th>
            </tr>
          </thead>
          <tbody>
            {data.weeks.map((w, i) => (
              <ForecastWeek key={w.start} week={w} items={data.items.filter((x) => x.week === i)} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />
            ))}
          </tbody>
        </table>
      </div>
      {!data.items.length && <Empty title="Nothing coming up in the books">No invoices or bills due, no pay runs and no monthly costs yet: the forecast fills in as you use Shap.</Empty>}
    </div>
  );
}

function ForecastWeek({ week, items, open, onToggle }: { week: Forecast['weeks'][number]; items: ForecastItem[]; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={items.length ? 'clickable' : ''} onClick={items.length ? onToggle : undefined} aria-expanded={items.length ? open : undefined}>
        <td className="nowrap">
          {formatDate(week.start)}
          {items.length > 0 && <span className="xs muted hide-sm"> · {items.length} item{items.length === 1 ? '' : 's'}</span>}
          {/* On a phone, in and out go under the week, so the week's end fits beside it. */}
          {(week.inCents > 0 || week.outCents > 0) && (
            <span className="show-sm xs muted">
              <br />
              {week.inCents > 0 && <span className="nowrap">in {formatZar(week.inCents, { cents: false })}</span>}
              {week.inCents > 0 && week.outCents > 0 && ' · '}
              {week.outCents > 0 && <span className="nowrap">out {formatZar(week.outCents, { cents: false })}</span>}
            </span>
          )}
        </td>
        <td className="num hide-sm">{week.inCents ? <Money cents={week.inCents} whole /> : '–'}</td>
        <td className="num hide-sm">{week.outCents ? <Money cents={-week.outCents} whole /> : '–'}</td>
        <td className={`num strong ${week.closingCents < 0 ? 'bad-figure' : ''}`}>
          <Money cents={week.closingCents} whole />
        </td>
      </tr>
      {open &&
        items.map((x, i) => (
          <tr key={`${x.date}-${i}`} className="sub-row">
            <td className="small muted">
              {formatDate(x.date)} · {x.label}
            </td>
            <td className="num small hide-sm">{x.cents > 0 ? <Money cents={x.cents} /> : ''}</td>
            <td className="num small hide-sm">{x.cents < 0 ? <Money cents={x.cents} /> : ''}</td>
            <td className="num small">
              <span className="show-sm">
                <Money cents={x.cents} />
              </span>
            </td>
          </tr>
        ))}
    </>
  );
}
