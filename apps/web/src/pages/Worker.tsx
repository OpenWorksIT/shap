import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatDate, formatZar, monthLabel, todayIso, WORKER_KIND_LABELS } from '@shap/shared';
import { LabourEntryForm } from '../components/LabourForm';
import { ProjectSelect } from '../components/Pickers';
import { PayForm } from '../components/PayForm';
import { PageHead } from '../components/Shell';
import { Drawer, Empty, ErrorBox, Field, Icon, Kpi, Loading, Money, MoneyInput, Segmented, Tabs, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { LabourEntry, WorkerRow } from '../lib/types';
import { WorkerDrawer } from './Workers';

interface MonthRow {
  month: string;
  days: number;
  wageCents: number;
  allowanceCents: number;
  earnedCents: number;
  paidCents: number;
}
interface WorkerDetail {
  worker: WorkerRow;
  months: MonthRow[];
  entries: LabourEntry[];
  payments: { id: string; date: string; amountCents: number; sourceName: string; note: string }[];
  savings: { id: string; date: string; amountCents: number; note: string }[];
  byProject: { name: string; projectId: string | null; days: number; costCents: number }[];
}

type Tab = 'months' | 'days' | 'payments' | 'jobs' | 'savings';

export default function WorkerPage() {
  const { id } = useParams<{ id: string }>();
  const { isOwner } = useAuthed();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<WorkerDetail>(`/api/workers/${id}`);
  const [tab, setTab] = useState<Tab>('months');
  const [drawer, setDrawer] = useState<null | 'pay' | 'edit' | 'saving' | 'settle' | { entry: LabourEntry }>(null);

  // Running saved/(advance) by month, oldest first, then grouped by year like the tracker's breakdown.
  const years = useMemo(() => {
    if (!data) return [];
    let running = 0;
    const asc = [...data.months].reverse().map((m) => ({ ...m, balance: (running += m.earnedCents - m.paidCents) }));
    const byYear = new Map<string, typeof asc>();
    for (const m of asc) {
      const y = m.month.slice(0, 4);
      byYear.set(y, [...(byYear.get(y) ?? []), m]);
    }
    return [...byYear.entries()].reverse().map(([year, months]) => ({ year, months: months.reverse() }));
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? { message: 'Not found' }} onRetry={reload} />;
  const w = data.worker;
  const earned = data.months.reduce((s, m) => s + m.earnedCents, 0);
  const paid = data.months.reduce((s, m) => s + m.paidCents, 0);
  const days = data.months.reduce((s, m) => s + m.days, 0);
  const savings = data.savings.reduce((s, x) => s + x.amountCents, 0);
  const balance = earned - paid;

  const delPayment = async (pid: string) => {
    if (!confirm('Delete this payment?')) return;
    await api(`/api/wage-payments/${pid}`, { method: 'DELETE' });
    toast('Payment deleted');
    void reload();
  };

  return (
    <div className="stack-lg">
      <PageHead
        back={{ to: '/workers', label: 'Workers' }}
        title={w.name}
        sub={`${WORKER_KIND_LABELS[w.kind]} · ${formatZar(w.dayRateCents, { cents: false })} a day${w.allowanceCents ? ` + ${formatZar(w.allowanceCents, { cents: false })} allowance` : ''}${w.phone ? ` · ${w.phone}` : ''}`}
        actions={
          isOwner && (
            <>
              <button className="btn primary" onClick={() => setDrawer('pay')}>
                <Icon name="money" size={18} />
                Pay
              </button>
              <button className="btn" onClick={() => setDrawer('saving')}>
                Savings
              </button>
              <button className="btn quiet" onClick={() => setDrawer('edit')} aria-label="Edit worker">
                <Icon name="edit" size={18} />
              </button>
            </>
          )
        }
      />
      <div className="kpis">
        <Kpi
          label={balance >= 0 ? 'You owe' : 'Advanced'}
          value={<Money cents={Math.abs(balance)} />}
          sub={
            balance < 0 && isOwner ? (
              <button className="btn quiet small" style={{ padding: 0, minHeight: 0 }} onClick={() => setDrawer('settle')}>
                What was it for? →
              </button>
            ) : balance > 0 ? (
              'earned, not yet paid'
            ) : balance < 0 ? (
              'paid ahead of work'
            ) : (
              'all square'
            )
          }
          tone={balance > 0 ? 'warn' : undefined}
        />
        <Kpi label="Earned (all time)" value={<Money cents={earned} whole />} sub={`${days} days`} />
        <Kpi label="Paid (all time)" value={<Money cents={paid} whole />} />
        {(savings !== 0 || data.savings.length > 0) && <Kpi label="Savings you hold" value={<Money cents={savings} />} sub="their money, kept for them" />}
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'months', label: 'By month' },
          { value: 'days', label: 'Days', count: data.entries.length },
          { value: 'payments', label: 'Payments', count: data.payments.length },
          { value: 'jobs', label: 'By job' },
          ...(data.savings.length ? [{ value: 'savings' as Tab, label: 'Savings', count: data.savings.length }] : []),
        ]}
      />
      {tab === 'months' && (
        <section className="panel table-wrap">
          <table className="table money-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Days</th>
                <th className="num hide-sm">Wages</th>
                <th className="num hide-sm">Allowances</th>
                <th className="num">Earned</th>
                <th className="num">Paid</th>
                <th className="num">Saved / (advance)</th>
              </tr>
            </thead>
            {years.map((y) => {
              const t = y.months.reduce((s, m) => ({ days: s.days + m.days, w: s.w + m.wageCents, a: s.a + m.allowanceCents, e: s.e + m.earnedCents, p: s.p + m.paidCents }), { days: 0, w: 0, a: 0, e: 0, p: 0 });
              return (
                <tbody key={y.year}>
                  <tr className="group">
                    <th scope="rowgroup">{y.year}</th>
                    <td className="num">{t.days}</td>
                    <td className="num hide-sm">{formatZar(t.w, { cents: false })}</td>
                    <td className="num hide-sm">{formatZar(t.a, { cents: false })}</td>
                    <td className="num">{formatZar(t.e, { cents: false })}</td>
                    <td className="num">{formatZar(t.p, { cents: false })}</td>
                    <td className="num">{bracket(t.e - t.p)}</td>
                  </tr>
                  {y.months.map((m) => (
                    <tr key={m.month}>
                      <td>{monthLabel(m.month)}</td>
                      <td className="num">{m.days || '–'}</td>
                      <td className="num hide-sm">{formatZar(m.wageCents, { cents: false })}</td>
                      <td className="num hide-sm">{formatZar(m.allowanceCents, { cents: false })}</td>
                      <td className="num">{formatZar(m.earnedCents, { cents: false })}</td>
                      <td className="num">{formatZar(m.paidCents, { cents: false })}</td>
                      <td className="num" title={`Running balance ${bracket(m.balance)}`}>
                        {bracket(m.earnedCents - m.paidCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </section>
      )}
      {tab === 'days' && (
        <section className="panel table-wrap">
          {data.entries.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Job / work</th>
                  <th className="num">Days</th>
                  <th className="num">Earned</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id} className={isOwner ? 'clickable' : ''} onClick={() => isOwner && setDrawer({ entry: e })}>
                    <td className="nowrap">{formatDate(e.date)}</td>
                    <td>
                      {e.projectId ? (
                        <Link to={`/jobs/${e.projectId}`} onClick={(x) => x.stopPropagation()}>
                          #{e.projectNumber} {e.projectName}
                        </Link>
                      ) : e.workTypeName ? (
                        <span className="muted">{e.workTypeName}</span>
                      ) : (
                        <span className="chip warn">Not allocated</span>
                      )}
                      {e.note && <div className="xs muted">{e.note}</div>}
                    </td>
                    <td className="num">{e.days}</td>
                    <td className="num">
                      <Money cents={e.wageCents + e.allowanceCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No days logged yet" />
          )}
        </section>
      )}
      {tab === 'payments' && (
        <section className="panel table-wrap">
          {data.payments.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Paid from</th>
                  <th className="num">Amount</th>
                  {isOwner && <th />}
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="nowrap">{formatDate(p.date)}</td>
                    <td>
                      {p.sourceName}
                      {p.note && <div className="xs muted">{p.note}</div>}
                    </td>
                    <td className="num">
                      <Money cents={p.amountCents} />
                    </td>
                    {isOwner && (
                      <td>
                        <button className="btn quiet small" onClick={() => void delPayment(p.id)} aria-label="Delete payment">
                          <Icon name="trash" size={16} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No payments yet" />
          )}
        </section>
      )}
      {tab === 'jobs' && (
        <section className="panel">
          <ul className="list">
            {data.byProject.map((b) => (
              <li key={b.name} className="list-row">
                {b.projectId ? (
                  <Link to={`/jobs/${b.projectId}`} className="grow">
                    {b.name}
                  </Link>
                ) : (
                  <span className="grow muted">{b.name}</span>
                )}
                <span className="small muted">{b.days} days</span>
                <Money cents={b.costCents} whole />
              </li>
            ))}
          </ul>
        </section>
      )}
      {tab === 'savings' && (
        <section className="panel">
          <ul className="list">
            {data.savings.map((s) => (
              <li key={s.id} className="list-row">
                <span className="nowrap small">{formatDate(s.date)}</span>
                <span className="grow small muted">{s.note}</span>
                <Money cents={s.amountCents} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {drawer === 'settle' && (
        <SettleAdvance workerId={w.id} name={w.name} advanceCents={-balance} onClose={() => setDrawer(null)} onDone={() => (setDrawer(null), void reload())} />
      )}
      {drawer === 'pay' && (
        <Drawer title={`Pay ${w.name}`} onClose={() => setDrawer(null)}>
          <PayForm workerId={w.id} onSaved={() => (setDrawer(null), void reload())} />
        </Drawer>
      )}
      {drawer === 'edit' && <WorkerDrawer worker={w} onClose={() => setDrawer(null)} onSaved={reload} />}
      {drawer === 'saving' && <SavingsDrawer workerId={w.id} name={w.name} onClose={() => setDrawer(null)} onSaved={reload} />}
      {drawer && typeof drawer === 'object' && (
        <Drawer title="Labour entry" onClose={() => setDrawer(null)}>
          <LabourEntryForm entry={drawer.entry} onSaved={() => (setDrawer(null), void reload())} onDeleted={() => (setDrawer(null), void reload())} />
        </Drawer>
      )}
    </div>
  );
}

const bracket = (c: number) => (c === 0 ? '–' : c > 0 ? formatZar(c, { cents: false }) : `(${formatZar(-c, { cents: false })})`);

function SavingsDrawer({ workerId, name, onClose, onSaved }: { workerId: string; name: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [dir, setDir] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!amount) return setError('Enter the amount');
    try {
      await api('/api/savings', { body: { workerId, date, amountCents: dir === 'in' ? amount : -amount, note: note || (dir === 'in' ? 'To savings' : 'From savings') } });
      toast('Saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title={`Savings for ${name}`} sub="Money they asked you to keep for them. A memo only, not in the company’s books." onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Segmented<'in' | 'out'> label="Direction" value={dir} onChange={setDir} options={[{ value: 'in', label: 'Put money in' }, { value: 'out', label: 'Paid out to them' }]} />
        <div className="form-grid">
          <Field label="Amount">{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
          <Field label="Date">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <Field label="Note">{(p) => <input {...p} className="input" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
      </form>
    </Drawer>
  );
}

/**
 * An advance is money paid with no work against it yet. Saying what it was for adds the
 * earnings it paid (days on a job, a bonus, general work) on the date you choose, so the
 * worker's balance, the job's labour cost and the books all follow, back to that date.
 */
function SettleAdvance({ workerId, name, advanceCents, onClose, onDone }: { workerId: string; name: string; advanceCents: number; onClose: () => void; onDone: () => void }) {
  const { ref } = useAuthed();
  const toast = useToast();
  const bonusType = ref.workTypes.find((t) => /bonus/i.test(t.name));
  const [what, setWhat] = useState<'job' | 'bonus' | 'general'>('job');
  const [amount, setAmount] = useState<number | null>(advanceCents);
  const [date, setDate] = useState(todayIso());
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workTypeId, setWorkTypeId] = useState(ref.workTypes.find((t) => t.active && t.id !== bonusType?.id)?.id ?? '');
  const [days, setDays] = useState('0');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!amount || amount <= 0) return setError('Enter the amount');
    if (what === 'job' && !projectId) return setError('Choose the job');
    try {
      await api('/api/labour', {
        body: {
          date,
          projectId: what === 'general' ? null : projectId,
          workTypeId: what === 'general' ? workTypeId : what === 'bonus' && !projectId ? (bonusType?.id ?? null) : null,
          note: note || (what === 'bonus' ? 'Bonus' : 'From an advance'),
          entries: [{ workerId, days: Number(days.replace(',', '.')) || 0, wageCents: amount, allowanceCents: 0 }],
        },
      });
      toast(`${formatZar(amount)} booked for ${name}`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title="What was the advance for?" sub={`${name} was paid ${formatZar(advanceCents)} more than they earned`} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Segmented
          label="It was for"
          value={what}
          onChange={setWhat}
          options={[
            { value: 'job', label: 'Work on a job' },
            { value: 'bonus', label: 'A bonus' },
            { value: 'general', label: 'General work' },
          ]}
        />
        <p className="xs muted">
          {what === 'job'
            ? 'Adds the work to the job, so its labour cost and profit include it.'
            : what === 'bonus'
              ? 'A bonus on top of their days. Put it on a job if it was for that job; otherwise it’s a general labour cost.'
              : 'Yard, quoting, collecting stock: labour that isn’t for one job.'}
        </p>
        <div className="form-grid">
          <Field label="Amount">{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
          <Field label="Date" hint="When it was earned; the books follow">
            {(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
        </div>
        {what !== 'general' && (
          <Field label={what === 'job' ? 'Job' : 'Job (optional)'}>{(p) => <ProjectSelect {...p} value={projectId} onChange={setProjectId} emptyLabel={what === 'job' ? 'Choose…' : 'Not for a job'} />}</Field>
        )}
        {what === 'general' && (
          <Field label="Type of work">
            {(p) => (
              <select {...p} className="select" value={workTypeId} onChange={(e) => setWorkTypeId(e.target.value)}>
                {ref.workTypes.filter((t) => t.active).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {what !== 'bonus' && (
          <Field label="Days (optional)" hint="Leave at 0 for a lump sum">
            {(p) => <input {...p} className="input" inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value.replace(/[^\d.,]/g, ''))} style={{ maxWidth: 100 }} />}
          </Field>
        )}
        <Field label="Note">{(p) => <input {...p} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={what === 'bonus' ? 'e.g. Christmas bonus' : 'e.g. Weekend on the Smith roof'} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Book it</button>
      </form>
    </Drawer>
  );
}
