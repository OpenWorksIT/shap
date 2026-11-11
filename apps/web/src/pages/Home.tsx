import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatPercent, formatZar, monthLabel } from '@shap/shared';
import { MonthChart } from '../components/MonthChart';
import { PageHead } from '../components/Shell';
import { DocChip, Empty, ErrorBox, Icon, Kpi, Loading, Money, ProjectChip, useToast } from '../components/ui';
import { stopClock, useMinuteTick, type Running } from '../components/TimeTracker';
import { ApiError } from '../lib/api';
import { reminderToast, sendReminder, type Remindable } from '../lib/reminders';
import { hoursLabel, minutesSince } from '../lib/time';
import { MarketNote } from '../components/MarketShare';
import { TestServerPanel, useTestServer } from '../components/TestServer';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { screensFor } from '../lib/screens';
import { greeting, say } from '../lib/words';
import type { ProjectRow } from '../lib/types';

interface Dashboard {
  today: string;
  financialYear: { start: string; end: string; label: string };
  thisMonth: { label: string; incomeCents: number; costOfSalesCents: number; expensesCents: number; profitCents: number };
  yearToDate: { incomeCents: number; grossProfitCents: number; expensesCents: number; profitCents: number };
  months: { key: string; label: string; incomeCents: number; costOfSalesCents: number; expensesCents: number }[];
  owing: { totalCents: number; overdue: number; invoices: { id: string; number: string; issueDate: string; totalCents: number; paidCents: number; clientName: string | null; projectName: string | null; paymentState: string }[] };
  workers: { id: string; name: string; balanceCents: number }[];
  owedToWorkersCents: number;
  unallocatedLabour: { n: number; cost: number; days: number };
  materialsWithoutJob: { n: number; total: number };
  uncapturedCosts: { n: number; total: number };
  statementsMissing?: { sourceId: string; sourceName: string; months: string[] }[];
  duplicateCosts?: number;
  vat?: { state: 'over' | 'near' | 'voluntary' | null; last12Cents: number; peak12Cents: number; peakTo: string; pace12Cents: number; compulsoryCents: number };
  monthlyInvoices?: {
    failed: { id: string; documentId: string; title: string; clientName: string | null; error: string }[];
    waiting: { id: string; scheduleId: string; number: string; clientName: string | null; mode: string }[];
  };
  sarsDue?: { kind: 'emp201' | 'dwt'; period: string; owingCents: number; dueOn: string; late: boolean }[];
  recurringMissing?: { key: string; label: string; months: string[]; usualCents: number; onStatement: boolean }[];
  overdue?: (Remindable & { issueDate: string; remindedAt: string | null; clientPhone: string | null; projectName: string | null })[];
  billsDue?: { id: string; supplier: string; description: string; dueDate: string | null; date: string; owingCents: number }[];
  timer?: Running | null;
  taxDue?: { key: string; label: string; due: string; to: string }[];
  /** This version's SARS tables were checked up to this year end, before the tax year we're in. */
  sarsCheckedTo?: string | null;
  /** For whoever may lock the books: month end due (last month still open), or the books reopened. */
  periods?: { monthDue: string | null; reopened: { relockDate: string; reason: string } | null; lockDate: string | null } | null;
  bankCents: number;
  ownerLoanCents: number;
  projects: ProjectRow[];
}

interface CaptureDashboard {
  recentLabour: { date: string; workerName: string; job: string; days: number }[];
}

export default function HomePage() {
  const { seesBooks, user } = useAuthed();
  if (!seesBooks) return <StaffHome name={user.name} />;
  return <OwnerHome />;
}

/** Home for staff who don't see the books: their jobs, one tap away. */
function StaffHome({ name }: { name: string }) {
  const { user, can, canAny, has, settings } = useAuthed();
  const may = screensFor(user, can, has, settings.businessType);
  const logsDays = has('workers') && canAny('labour.log', 'workers.manage');
  const { data } = useApi<CaptureDashboard>('/api/dashboard');
  const quick = [
    may['/sales'] && can('sales.sell') && { to: '/sales', icon: 'till' as const, label: 'Sell' },
    logsDays && { to: '/log?tab=labour', icon: 'workers' as const, label: 'Day’s work' },
    canAny('costs.capture', 'costs.manage') && { to: '/log?tab=cost', icon: 'camera' as const, label: 'Cost & slip' },
    may['/inventory'] && { to: '/inventory', icon: 'box' as const, label: can('stock.count') ? 'Stock & counts' : 'Stock' },
    may['/documents'] && { to: '/documents', icon: 'docs' as const, label: has('quotes') ? 'Quotes & invoices' : 'Invoices' },
    may['/jobs'] && { to: '/jobs', icon: 'jobs' as const, label: 'Jobs' },
  ].filter(Boolean) as { to: string; icon: 'till'; label: string }[];
  return (
    <div className="narrow stack-lg">
      <PageHead title={`Howzit, ${name.split(' ')[0]}`} sub={quick.length ? 'What’s next?' : 'The owner hasn’t given you anything to do in Shap yet.'} />
      {quick.length > 0 && (
        <div className="quick-actions">
          {quick.map((q) => (
            <Link key={q.to} to={q.to} className="quick">
              <Icon name={q.icon} size={26} />
              {q.label}
            </Link>
          ))}
        </div>
      )}
      {logsDays && <section className="panel">
        <div className="panel-head strong">What you logged lately</div>
        {data?.recentLabour.length ? (
          <ul className="list">
            {data.recentLabour.map((r, i) => (
              <li key={i} className="list-row">
                <span className="grow">
                  <strong>{r.workerName}</strong> · {r.job}
                </span>
                <span className="small muted">{formatDate(r.date)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="Nothing yet">Days you log show up here.</Empty>
        )}
      </section>}
    </div>
  );
}

function OwnerHome() {
  const { settings, can, has, user } = useAuthed();
  // Reminders and new quotes are for whoever makes the invoices.
  const isOwner = can('documents.edit');
  const logs = screensFor(user, can, has, settings.businessType)['/log'];
  const { data, error, reload } = useApi<Dashboard>('/api/dashboard');
  const toast = useToast();
  // A test server shares nothing: no note about sharing prices.
  const [testServer] = useTestServer();
  useMinuteTick();
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const ytdMargin = data.yearToDate.incomeCents ? data.yearToDate.grossProfitCents / data.yearToDate.incomeCents : null;
  const billsLate = (data.billsDue ?? []).filter((b) => (b.dueDate ?? b.date) < data.today);
  const billsOwing = (data.billsDue ?? []).reduce((s, b) => s + Number(b.owingCents), 0);
  const needs = [
    data.timer && (
      <div key="timer" className="attention">
        <Icon name="clock" size={18} />
        <span className="grow">
          <strong className="timer-on">● {hoursLabel(minutesSince(data.timer.startedAt))}</strong> on{' '}
          {data.timer.projectId ? <Link to={`/jobs/${data.timer.projectId}`}>{data.timer.projectName}</Link> : 'time with no job'}
        </span>
        <button
          className="btn small"
          onClick={() =>
            void stopClock()
              .then(() => (toast('Clock stopped'), reload()))
              .catch((e: unknown) => toast(e instanceof ApiError ? e.message : 'Couldn’t stop the clock', 'error'))
          }
        >
          Stop
        </button>
      </div>
    ),
    data.periods?.reopened && (
      <Link key="reopened" to="/accounts?tab=locks" className="attention">
        <Icon name="alert" size={18} />
        <span className="grow">
          <strong>The books are reopened</strong>
          {data.periods.lockDate ? ` from ${formatDate(data.periods.lockDate)}` : ''} ({data.periods.reopened.reason}). Lock them again once it’s put right.
        </span>
        Locks
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
    !data.periods?.reopened && data.periods?.monthDue && (
      <Link key="month-end" to="/accounts?tab=locks" className="attention">
        <Icon name="calendar" size={18} />
        <span className="grow">
          <strong>Month end</strong>: {monthLabel(data.periods.monthDue.slice(0, 7))} is still open. Check it over and close it.
        </span>
        Month end
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
    data.sarsCheckedTo && (
      <Link key="sars-tables" to="/settings?tab=system" className="attention">
        <Icon name="alert" size={18} />
        <span className="grow">
          <strong>SARS’s new tax year</strong>: this version of Shap has SARS’s tables up to the year ended {formatDate(data.sarsCheckedTo)}. Update Shap before you run payroll or estimate tax for the new year.
        </span>
        Updates
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
    ...(data.taxDue ?? []).map((t) => (
      <Link key={t.key} to={t.to} className="attention">
        <Icon name="calendar" size={18} />
        <span className="grow">
          <strong>SARS: {t.label}</strong> due by {formatDate(t.due)}
        </span>
        Figures
        <Icon name="chevronRight" size={16} />
      </Link>
    )),
    (data.billsDue ?? []).length > 0 && (
      <Link key="bills" to="/bills" className="attention">
        <Icon name="bill" size={18} />
        <span className="grow">
          <strong>
            {data.billsDue!.length} supplier bill{data.billsDue!.length === 1 ? '' : 's'}
          </strong>{' '}
          {billsLate.length ? `to pay (${billsLate.length} overdue)` : 'due this week'}: <Money cents={billsOwing} whole />
        </span>
        Pay
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
    ...(data.sarsDue ?? []).map((d) => (
      <Link key={`sars-${d.kind}-${d.period}`} to="/payroll?tab=sars" className="attention">
        <Icon name="alert" size={18} />
        <span className="grow">
          <strong>SARS: {d.kind === 'emp201' ? `PAYE, UIF and SDL for ${monthLabel(d.period)}` : `dividends tax for ${monthLabel(d.period)}`}</strong>, <Money cents={d.owingCents} />{' '}
          {d.late ? `was due ${formatDate(d.dueOn)}` : `due by ${formatDate(d.dueOn)}`}
        </span>
        Pay
        <Icon name="chevronRight" size={16} />
      </Link>
    )),
    (data.vat?.state === 'over' || data.vat?.state === 'near') && (
      <Link key="vat" to="/settings" className="attention">
        <Icon name="alert" size={18} />
        <span className="grow">
          {data.vat.state === 'over' ? (
            <>
              <strong>Register for VAT:</strong> <Money cents={data.vat.peak12Cents} whole /> of income in the 12 months to {formatDate(data.vat.peakTo)} is over the{' '}
              <Money cents={data.vat.compulsoryCents} whole /> line (any 12 months in a row count). SARS expects you to register within 21 days of passing it.
            </>
          ) : (
            <>
              <strong>Nearing the VAT line:</strong> <Money cents={data.vat.peak12Cents} whole /> in {data.vat.peak12Cents !== data.vat.last12Cents ? `the 12 months to ${formatDate(data.vat.peakTo)}` : 'the last 12 months'}
              {data.vat.pace12Cents > data.vat.compulsoryCents ? <>, and lately running at <Money cents={data.vat.pace12Cents} whole /> over 12 months</> : null}. Registration is
              compulsory once any 12 months in a row pass <Money cents={data.vat.compulsoryCents} whole />.
            </>
          )}
        </span>
        Check
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
    has('workers') && data.unallocatedLabour.n > 0 && (
      <Link key="lab" to="/workers?tab=allocate" className="attention">
        <Icon name="alert" size={18} />
        <span className="grow">
          <strong>{data.unallocatedLabour.n} labour day{data.unallocatedLabour.n === 1 ? '' : 's'}</strong> not on a job or general work (<Money cents={data.unallocatedLabour.cost} whole />)
        </span>
        Allocate
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
    ...(data.monthlyInvoices?.failed ?? []).map((f) => (
      <Link key={`mf-${f.id}`} to={`/documents/${f.documentId}`} className="attention">
        <Icon name="mail" size={18} />
        <span className="grow">
          <strong>Monthly invoice{f.clientName ? ` for ${f.clientName}` : ''}</strong> didn’t work: {f.error}
        </span>
        Fix
        <Icon name="chevronRight" size={16} />
      </Link>
    )),
    ...(data.monthlyInvoices?.waiting ?? [])
      // One that failed already says so above.
      .filter((w) => !data.monthlyInvoices!.failed.some((f) => f.id === w.scheduleId))
      .map((w) => (
        <Link key={`mw-${w.id}`} to={`/documents/${w.id}`} className="attention">
          <Icon name="mail" size={18} />
          <span className="grow">
            <strong>Monthly invoice {w.number}</strong>
            {w.clientName ? ` for ${w.clientName}` : ''} {w.mode === 'draft' ? 'is ready for you to check and send' : 'was made but not emailed'}
          </span>
          {w.mode === 'draft' ? 'Check' : 'Send'}
          <Icon name="chevronRight" size={16} />
        </Link>
      )),
    (data.recurringMissing ?? []).length > 0 && (
      <Link key="rec" to="/costs?kind=recurring" className="attention">
        <Icon name="alert" size={18} />
        <span className="grow">
          <strong>
            {data.recurringMissing!.length} monthly cost{data.recurringMissing!.length === 1 ? '' : 's'} missing:
          </strong>{' '}
          {data
            .recurringMissing!.slice(0, 3)
            .map((r) => `${r.label} (${r.months.map((m) => monthLabel(m, false)).join(', ')}${r.onStatement ? ', on the statement' : ''})`)
            .join(', ')}
          {data.recurringMissing!.length > 3 ? '…' : ''}
        </span>
        Check
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
    (data.duplicateCosts ?? 0) > 0 && (
      <Link key="dup" to="/costs?kind=duplicates" className="attention">
        <Icon name="alert" size={18} />
        <span className="grow">
          <strong>
            {data.duplicateCosts} cost{data.duplicateCosts === 1 ? '' : 's'}
          </strong>{' '}
          look counted twice
        </span>
        Merge
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
    has('jobs') && data.materialsWithoutJob.n > 0 && (
      <Link key="mat" to="/costs?kind=materials-unallocated" className="attention">
        <Icon name="alert" size={18} />
        <span className="grow">
          <strong>{data.materialsWithoutJob.n} parts purchase{data.materialsWithoutJob.n === 1 ? '' : 's'}</strong> this year without a job (<Money cents={data.materialsWithoutJob.total} whole />)
        </span>
        Review
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
    data.uncapturedCosts.n > 0 && (
      <Link key="unc" to="/costs?source=none" className="attention">
        <Icon name="alert" size={18} />
        <span className="grow">
          <strong>{data.uncapturedCosts.n} cost{data.uncapturedCosts.n === 1 ? '' : 's'}</strong> don’t say which account paid them yet (<Money cents={data.uncapturedCosts.total} whole />)
        </span>
        Capture
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
    ...(data.statementsMissing ?? []).map((m) => (
      <Link key={`st-${m.sourceId}`} to={`/accounts?tab=files&source=${m.sourceId}&month=${m.months[0]}`} className="attention">
        <Icon name="upload" size={18} />
        <span className="grow">
          <strong>{m.sourceName}</strong> statement{m.months.length === 1 ? '' : 's'} not on file: {monthLabel(m.months[0]!)}
          {m.months.length > 1 ? ` and ${m.months.length - 1} more` : ''}
        </span>
        Upload
        <Icon name="chevronRight" size={16} />
      </Link>
    )),
    data.owing.overdue > 0 && !(isOwner && has('reminders')) && (
      <Link key="over" to="/documents?kind=invoice&state=overdue" className="attention">
        <Icon name="alert" size={18} />
        <span className="grow">
          <strong>{data.owing.overdue} invoice{data.owing.overdue === 1 ? '' : 's'}</strong> past due
        </span>
        Follow up
        <Icon name="chevronRight" size={16} />
      </Link>
    ),
  ].filter(Boolean);

  return (
    <div className="stack-lg">
      <PageHead
        title={greeting()}
        sub={`${settings.tradingName || settings.companyName} · ${data.financialYear.label} (${formatDate(data.financialYear.start)} to ${formatDate(data.financialYear.end)})`}
        actions={
          (logs || isOwner) && (
            <>
              {logs && (
                <Link to="/log" className="btn primary">
                  <Icon name="plus" size={18} />
                  Log
                </Link>
              )}
              {isOwner && (
                <Link to={has('quotes') ? '/documents/new?kind=quote' : '/documents/new?kind=invoice'} className="btn">
                  {has('quotes') ? 'New quote' : 'New invoice'}
                </Link>
              )}
            </>
          )
        }
      />

      <TestServerPanel />
      <div className="kpis">
        <Kpi label={`Invoiced ${data.financialYear.label} to date`} value={<Money cents={data.yearToDate.incomeCents} whole />} sub={`${data.thisMonth.label}: ${formatZar(data.thisMonth.incomeCents, { cents: false })}`} />
        <Kpi label="Gross profit" value={<Money cents={data.yearToDate.grossProfitCents} whole />} sub={`${formatPercent(ytdMargin)} of invoiced`} />
        <Kpi label="Net profit to date" value={<Money cents={data.yearToDate.profitCents} whole />} sub={`after ${formatZar(data.yearToDate.expensesCents, { cents: false })} running costs`} tone={data.yearToDate.profitCents < 0 ? 'bad' : undefined} />
        <Kpi label="Clients owe you" value={<Money cents={data.owing.totalCents} whole />} sub={data.owing.overdue ? `${data.owing.overdue} overdue` : 'nothing overdue'} tone={data.owing.overdue ? 'warn' : undefined} />
        {has('workers') && <Kpi
          label={data.owedToWorkersCents < 0 ? 'Advanced to workers' : 'You owe workers'}
          value={<Money cents={Math.abs(data.owedToWorkersCents)} whole />}
          sub={data.owedToWorkersCents < 0 ? 'paid ahead of days worked' : 'earned, not yet paid'}
        />}
      </div>

      {!testServer?.on && <MarketNote />}
      {needs.length > 0 && <div className="stack" style={{ gap: 8 }}>{needs}</div>}

      {isOwner && has('reminders') && (data.overdue ?? []).length > 0 && <Reminders invoices={data.overdue!} today={data.today} onSent={reload} />}

      <div className="two-col">
        <section className="panel panel-pad">
          <MonthChart
            title="Income and costs, last 12 months"
            data={data.months.map((m) => ({ key: m.key, label: m.label, incomeCents: m.incomeCents, costsCents: m.costOfSalesCents + m.expensesCents }))}
          />
        </section>
        <section className="panel">
          <div className="panel-head spread">
            <strong>Waiting for payment</strong>
            <Link to="/documents?kind=invoice&state=owing" className="small">
              All
            </Link>
          </div>
          {data.owing.invoices.length ? (
            <ul className="list">
              {data.owing.invoices.map((i) => (
                <li key={i.id}>
                  <Link to={`/documents/${i.id}`} className="list-row">
                    <span className="grow" style={{ minWidth: 0 }}>
                      <strong className="ellipsis" style={{ display: 'block' }}>
                        {i.number} · {i.clientName ?? i.projectName ?? 'No name yet'}
                      </strong>
                      <span className="xs muted">{formatDate(i.issueDate)}</span>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <Money cents={i.totalCents - i.paidCents} />
                      <br />
                      <DocChip status="issued" paymentState={i.paymentState} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title={say('allPaid')} />
          )}
        </section>
      </div>

      {has('jobs') && (
      <section className="panel">
        <div className="panel-head spread">
          <strong>Jobs on the go</strong>
          <Link to="/jobs" className="small">
            All jobs
          </Link>
        </div>
        {data.projects.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th className="num">Quoted</th>
                  <th className="num">Spent</th>
                  <th className="num">Invoiced</th>
                  <th className="num hide-sm">Profit</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/jobs/${p.id}`} className="strong">
                        #{p.number} {p.name}
                      </Link>
                      {p.clientName && <div className="xs muted">{p.clientName}</div>}
                    </td>
                    <td>
                      <ProjectChip status={p.status} />
                    </td>
                    <td className="num">
                      <Money cents={p.quotedCents || null} whole />
                    </td>
                    <td className="num">
                      <Money cents={p.actualCents} whole />
                      {p.quotedCents > 0 && <SpendBar spent={p.actualCents} budget={p.quotedCents} />}
                    </td>
                    <td className="num">
                      <Money cents={p.invoicedCents || null} whole />
                    </td>
                    <td className="num hide-sm">
                      <Money cents={p.invoicedCents ? p.grossProfitCents : null} whole />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No open jobs">Start one from Jobs, or with a new quote.</Empty>
        )}
      </section>
      )}
    </div>
  );
}

/** Spent against quoted: amber past 85%, red over budget. */
export function SpendBar({ spent, budget }: { spent: number; budget: number }) {
  const ratio = budget ? spent / budget : 0;
  const tone = ratio > 1 ? 'over' : ratio > 0.85 ? 'near' : '';
  return (
    <div className={`spend ${tone}`} title={`${Math.round(ratio * 100)}% of the quote`}>
      <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
    </div>
  );
}

/** Overdue invoices, each a tap away from a reminder: emailed when the server can, or the PDF and a message to paste. */
function Reminders({ invoices, today, onSent }: { invoices: NonNullable<Dashboard['overdue']>; today: string; onSent: () => void }) {
  const { settings, has, ref } = useAuthed();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const days = (from: string) => Math.max(0, Math.round((Date.parse(today) - Date.parse(from.slice(0, 10))) / 86_400_000));
  const send = async (inv: (typeof invoices)[number]) => {
    setBusy(inv.id);
    try {
      const how = await sendReminder(inv, settings, { payshap: has('payshap'), emailOn: Boolean(ref.emailOn) });
      if (how) {
        toast(reminderToast(how, inv));
        onSent();
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t send the reminder', 'error');
    } finally {
      setBusy(null);
    }
  };
  const shown = all ? invoices : invoices.slice(0, 4);
  return (
    <section className="panel">
      <div className="panel-head spread">
        <span>
          <strong>Send reminders now</strong>
          <div className="xs muted">{ref.emailOn ? 'Past due: emailed with the invoice attached (or ready to paste into WhatsApp if there’s no email address).' : 'Past due: the invoice and a friendly message, ready for WhatsApp or email.'}</div>
        </span>
        <Link to="/documents?kind=invoice&state=overdue" className="small">
          All
        </Link>
      </div>
      <ul className="list">
        {shown.map((i) => (
          <li key={i.id} className="list-row">
            <Link to={`/documents/${i.id}`} className="grow" style={{ minWidth: 0 }}>
              <strong className="ellipsis" style={{ display: 'block' }}>
                {i.number} · {i.clientName ?? i.projectName ?? 'No name yet'}
              </strong>
              <span className="xs muted">
                <Money cents={Number(i.totalCents) - Number(i.paidCents)} /> · {i.dueDate ? `${days(i.dueDate)} days late` : 'overdue'}
                {i.remindedAt ? ` · reminded ${days(i.remindedAt) === 0 ? 'today' : `${days(i.remindedAt)} days ago`}` : ''}
              </span>
            </Link>
            <button className={`btn small ${i.remindedAt && days(i.remindedAt) < 3 ? '' : 'primary'}`} disabled={busy !== null} onClick={() => void send(i)}>
              <Icon name={ref.emailOn && i.clientEmail ? 'mail' : 'share'} size={14} />
              {busy === i.id ? '…' : ref.emailOn && i.clientEmail ? 'Email' : 'Send'}
            </button>
          </li>
        ))}
      </ul>
      {invoices.length > shown.length && (
        <button className="btn quiet small block" onClick={() => setAll(true)}>
          {invoices.length - shown.length} more
        </button>
      )}
    </section>
  );
}
