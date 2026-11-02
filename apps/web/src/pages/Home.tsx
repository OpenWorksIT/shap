import { Link } from 'react-router-dom';
import { formatDate, formatPercent, formatZar, monthLabel } from '@shap/shared';
import { MonthChart } from '../components/MonthChart';
import { PageHead } from '../components/Shell';
import { DocChip, Empty, ErrorBox, Icon, Kpi, Loading, Money, ProjectChip } from '../components/ui';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { greeting, say } from '../lib/words';
import { lastBackup } from '../lib/backup';
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
  vat?: { state: 'over' | 'near' | 'voluntary' | null; last12Cents: number; pace12Cents: number; compulsoryCents: number };
  monthlyInvoices?: {
    failed: { id: string; documentId: string; title: string; clientName: string | null; error: string }[];
    waiting: { id: string; scheduleId: string; number: string; clientName: string | null; mode: string }[];
  };
  sarsDue?: { kind: 'emp201' | 'dwt'; period: string; owingCents: number; dueOn: string; late: boolean }[];
  recurringMissing?: { key: string; label: string; months: string[]; usualCents: number; onStatement: boolean }[];
  bankCents: number;
  ownerLoanCents: number;
  projects: ProjectRow[];
}

interface CaptureDashboard {
  recentLabour: { date: string; workerName: string; job: string; days: number }[];
}

export default function HomePage() {
  return <OwnerHome />;
}

function OwnerHome() {
  const { settings, isOwner, has } = useAuthed();
  const { data, error, reload } = useApi<Dashboard>('/api/dashboard');
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const ytdMargin = data.yearToDate.incomeCents ? data.yearToDate.grossProfitCents / data.yearToDate.incomeCents : null;
  const lastSaved = lastBackup();
  const backupDays = lastSaved ? Math.floor((Date.now() - lastSaved.getTime()) / 86_400_000) : null;
  const needs = [
    (backupDays === null ? data.owing.invoices.length > 0 || data.yearToDate.incomeCents !== 0 : backupDays > 7) && (
      <Link key="backup" to="/backup" className="attention">
        <Icon name="upload" size={18} />
        <span className="grow">
          <strong>{backupDays === null ? 'No backup yet.' : `Last backup ${backupDays} days ago.`}</strong> Your books are only on this phone: save a copy to your cloud drive.
        </span>
        Back up
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
              <strong>Register for VAT:</strong> <Money cents={data.vat.last12Cents} whole /> of income in the last 12 months is over the{' '}
              <Money cents={data.vat.compulsoryCents} whole /> line. SARS expects you to register within 21 days of passing it.
            </>
          ) : (
            <>
              <strong>Nearing the VAT line:</strong> <Money cents={data.vat.last12Cents} whole /> in the last 12 months
              {data.vat.pace12Cents > data.vat.compulsoryCents ? <>, and lately running at <Money cents={data.vat.pace12Cents} whole /> a year</> : null}. Registration is
              compulsory past <Money cents={data.vat.compulsoryCents} whole />.
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
    data.owing.overdue > 0 && (
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
          isOwner && (
            <>
              <Link to="/log" className="btn primary">
                <Icon name="plus" size={18} />
                Add a cost
              </Link>
              <Link to={`/documents/new?kind=${has('quotes') ? 'quote' : 'invoice'}`} className="btn">
                {has('quotes') ? 'New quote' : 'New invoice'}
              </Link>
            </>
          )
        }
      />

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

      {needs.length > 0 && <div className="stack" style={{ gap: 8 }}>{needs}</div>}

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
