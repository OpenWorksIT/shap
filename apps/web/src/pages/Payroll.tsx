/**
 * Payroll: employees, monthly pay runs (PAYE, UIF, SDL worked out on SARS's tables), payslips,
 * what SARS is owed and paying it; and, for a company, dividends to its shareholders.
 */
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AGE_BAND_LABELS, formatDate, formatZar, idNumberProblem, taxNumberProblem, todayIso, type AgeBand, entity, paysOutProfit } from '@shap/shared';
import { FileButton } from '../components/Files';
import { PageHead } from '../components/Shell';
import { Drawer, Empty, ErrorBox, Field, Icon, Loading, Money, MoneyInput, Tabs, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';

type Tab = 'runs' | 'people' | 'sars' | 'dividends';

interface Employee {
  id: string;
  name: string;
  idNumber: string;
  taxNumber: string;
  isDirector: boolean;
  salaryCents: number;
  ageBand: AgeBand;
  medicalMembers: number;
  uif: boolean;
  startDate: string;
  endDate: string | null;
  bankDetails: string;
  active: boolean;
}
interface RunRow {
  id: string;
  period: string;
  payDate: string;
  status: 'draft' | 'final';
  grossCents: number;
  payeCents: number;
  uifCents: number;
  sdlCents: number;
  netCents: number;
  people: number;
}
interface Line {
  employeeId: string;
  name: string;
  isDirector: boolean;
  salaryCents: number;
  overtimeCents: number;
  commissionCents: number;
  extraCents: number;
  grossCents: number;
  payeCents: number;
  uifEmployeeCents: number;
  uifEmployerCents: number;
  sdlCents: number;
  netCents: number;
  note: string;
}

const monthName = (period: string) => new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const thisPeriod = () => todayIso().slice(0, 7);

export default function PayrollPage() {
  const { settings, has, words } = useAuthed();
  const [params, setParams] = useSearchParams();
  const dividends = paysOutProfit(settings.businessType) && has('dividends');
  const payroll = has('payroll');
  const fallback: Tab = payroll ? 'runs' : 'dividends';
  const tab = (params.get('tab') as Tab) || fallback;
  const tabs = [
    ...(payroll
      ? [
          { value: 'runs' as Tab, label: 'Pay runs' },
          { value: 'people' as Tab, label: 'Employees' },
        ]
      : []),
    { value: 'sars' as Tab, label: 'SARS' },
    ...(dividends ? [{ value: 'dividends' as Tab, label: words.Payouts }] : []),
  ];
  return (
    <div className="stack-lg">
      <PageHead title={payroll ? 'Payroll' : words.Payouts} sub={payroll ? 'Salaries with PAYE, UIF and SDL worked out for you, and payslips to send.' : undefined} />
      <Tabs<Tab> value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} tabs={tabs} />
      {tab === 'runs' && payroll && <Runs />}
      {tab === 'people' && payroll && <Employees />}
      {tab === 'sars' && <Sars />}
      {tab === 'dividends' && dividends && <Dividends />}
    </div>
  );
}

/* ---------------------------------------------------------------- pay runs */
function Runs() {
  const { ref } = useAuthed();
  const toast = useToast();
  const { data, error, reload } = useApi<RunRow[]>('/api/pay-runs');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bank = ref.sources.find((s) => s.kind === 'bank' && s.active) ?? ref.sources[0];
  const next = (() => {
    const have = new Set((data ?? []).map((r) => r.period));
    let p = thisPeriod();
    while (have.has(p)) {
      const [y, m] = p.split('-').map(Number) as [number, number];
      p = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    }
    return p;
  })();
  const start = async () => {
    setBusy(true);
    try {
      const [y, m] = next.split('-').map(Number) as [number, number];
      const payDate = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const r = await api<{ id: string }>('/api/pay-runs', { body: { period: next, payDate, sourceId: bank?.id } });
      await reload();
      setOpen(r.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t start the pay run', 'error');
    } finally {
      setBusy(false);
    }
  };
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <div className="row">
        <button className="btn primary" onClick={() => void start()} disabled={busy}>
          <Icon name="plus" size={18} />
          Pay {monthName(next)}
        </button>
      </div>
      {data.length ? (
        <section className="panel">
          <ul className="list">
            {data.map((r) => (
              <li key={r.id}>
                <button className="list-row" onClick={() => setOpen(r.id)}>
                  <span className="grow">
                    <strong>{monthName(r.period)}</strong> {r.status === 'draft' && <span className="chip d-draft">draft</span>}
                    <div className="xs muted">
                      {r.people} paid on {formatDate(r.payDate)} · PAYE {formatZar(r.payeCents)} · UIF {formatZar(r.uifCents)}
                    </div>
                  </span>
                  <Money cents={r.netCents} />
                  <Icon name="chevronRight" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Empty title="No pay runs yet">Add your employees, then pay the month. Shap works out PAYE, UIF and SDL on SARS’s tables and makes the payslips.</Empty>
      )}
      {open && <RunDrawer id={open} onClose={() => (setOpen(null), void reload())} />}
    </div>
  );
}

function RunDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { ref } = useAuthed();
  const toast = useToast();
  const { data, error, reload } = useApi<{ run: { id: string; period: string; payDate: string; status: string; sourceId: string }; lines: Line[] }>(`/api/pay-runs/${id}`);
  const [edit, setEdit] = useState<Line | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      if (done) toast(done);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Something went wrong', 'error');
    } finally {
      setBusy(false);
    }
  };
  if (error) return <Drawer title="Pay run" onClose={onClose}><ErrorBox error={error} onRetry={reload} /></Drawer>;
  if (!data) return <Drawer title="Pay run" onClose={onClose}><Loading /></Drawer>;
  const { run, lines } = data;
  const draft = run.status === 'draft';
  const total = (k: keyof Line) => lines.reduce((s, l) => s + Number(l[k] ?? 0), 0);
  return (
    <Drawer title={monthName(run.period)} sub={draft ? 'Draft: check it, then finalise' : `Paid ${formatDate(run.payDate)}`} onClose={onClose} wide>
      <div className="stack">
        {draft && (
          <div className="form-grid">
            <Field label="Pay date">
              {(p) => <input {...p} className="input" type="date" value={run.payDate} onChange={(e) => void act(() => api(`/api/pay-runs/${id}`, { method: 'PUT', body: { payDate: e.target.value, sourceId: run.sourceId } }))} />}
            </Field>
            <Field label="Paid from">
              {(p) => (
                <select {...p} className="select" value={run.sourceId} onChange={(e) => void act(() => api(`/api/pay-runs/${id}`, { method: 'PUT', body: { payDate: run.payDate, sourceId: e.target.value } }))}>
                  {ref.sources.filter((s) => s.active && !s.role).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        )}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th className="num hide-sm">Gross</th>
                <th className="num">PAYE</th>
                <th className="num hide-sm">UIF</th>
                <th className="num">Net</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.employeeId}>
                  <td>
                    {draft ? (
                      <button className="link-btn" onClick={() => setEdit(l)}>
                        {l.name}
                      </button>
                    ) : (
                      l.name
                    )}
                    {l.overtimeCents > 0 && <div className="xs muted">+ {formatZar(l.overtimeCents)} overtime</div>}
                    {l.commissionCents > 0 && <div className="xs muted">+ {formatZar(l.commissionCents)} commission</div>}
                    {l.extraCents > 0 && <div className="xs muted">+ {formatZar(l.extraCents)} {l.note || 'bonus'}</div>}
                  </td>
                  <td className="num hide-sm"><Money cents={l.grossCents} /></td>
                  <td className="num"><Money cents={l.payeCents} /></td>
                  <td className="num hide-sm"><Money cents={l.uifEmployeeCents} /></td>
                  <td className="num strong"><Money cents={l.netCents} /></td>
                  <td>
                    <FileButton className="btn quiet small" path={`/api/pay-runs/${id}/payslip/${l.employeeId}`} title={`Payslip ${l.name}`} aria-label={`Payslip for ${l.name}`}>
                      <Icon name="share" size={14} />
                    </FileButton>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="sub">
                <td>Total</td>
                <td className="num hide-sm"><Money cents={total('grossCents')} /></td>
                <td className="num"><Money cents={total('payeCents')} /></td>
                <td className="num hide-sm"><Money cents={total('uifEmployeeCents')} /></td>
                <td className="num"><Money cents={total('netCents')} /></td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="xs muted">
          Also paid by you: UIF {formatZar(total('uifEmployerCents'))}
          {total('sdlCents') ? `, SDL ${formatZar(total('sdlCents'))}` : ''}. SARS is owed {formatZar(total('payeCents') + total('uifEmployeeCents') + total('uifEmployerCents') + total('sdlCents'))} for this month (EMP201), by the 7th.
        </p>
        {draft ? (
          <div className="row wrap">
            <button className="btn primary" disabled={busy} onClick={() => void act(() => api(`/api/pay-runs/${id}/finalise`, { body: {} }), 'Pay run final: it’s in the books')}>
              <Icon name="check" size={18} />
              Finalise (pays net from {ref.sources.find((s) => s.id === run.sourceId)?.name ?? 'the bank'})
            </button>
            <button className="btn quiet danger" disabled={busy} onClick={() => confirm('Delete this draft pay run?') && void act(() => api(`/api/pay-runs/${id}`, { method: 'DELETE' })).then(onClose)}>
              Delete draft
            </button>
          </div>
        ) : (
          <button className="btn quiet" disabled={busy} onClick={() => confirm('Reopen this pay run? It comes out of the books until you finalise it again.') && void act(() => api(`/api/pay-runs/${id}/reopen`, { body: {} }), 'Reopened')}>
            Reopen to change it
          </button>
        )}
      </div>
      {edit && (
        <LineDrawer
          line={edit}
          onClose={() => setEdit(null)}
          onSave={(body) =>
            void act(() => api(`/api/pay-runs/${id}/lines/${edit.employeeId}`, { method: 'PUT', body })).then(() => setEdit(null))
          }
          onRemove={() => void act(() => api(`/api/pay-runs/${id}/lines/${edit.employeeId}`, { method: 'DELETE' })).then(() => setEdit(null))}
        />
      )}
    </Drawer>
  );
}

function LineDrawer({ line, onClose, onSave, onRemove }: { line: Line; onClose: () => void; onSave: (b: { salaryCents: number; overtimeCents: number; commissionCents: number; extraCents: number; note: string }) => void; onRemove: () => void }) {
  const [salary, setSalary] = useState<number | null>(line.salaryCents);
  const [overtime, setOvertime] = useState<number | null>(line.overtimeCents || null);
  const [commission, setCommission] = useState<number | null>(line.commissionCents || null);
  const [extra, setExtra] = useState<number | null>(line.extraCents || null);
  const [note, setNote] = useState(line.note);
  return (
    <Drawer title={line.name} sub="This month only" onClose={onClose}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), onSave({ salaryCents: salary ?? 0, overtimeCents: overtime ?? 0, commissionCents: commission ?? 0, extraCents: extra ?? 0, note }))}>
        <Field label="Salary this month" hint="Less for a part month or unpaid leave">{(p) => <MoneyInput {...p} value={salary} onChange={setSalary} />}</Field>
        <Field label="Overtime (optional)" hint="Taxed with the salary, as SARS’s tables do">{(p) => <MoneyInput {...p} value={overtime} onChange={setOvertime} />}</Field>
        <Field label="Commission (optional)" hint="Taxed with the salary; no UIF on commission">{(p) => <MoneyInput {...p} value={commission} onChange={setCommission} />}</Field>
        <Field label="Bonus or other once-off pay (optional)" hint="Taxed as the tax it adds to the year, on top of any earlier bonus">{(p) => <MoneyInput {...p} value={extra} onChange={setExtra} />}</Field>
        {Boolean(extra) && <Field label="What it’s for">{(p) => <input {...p} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Year-end bonus" />}</Field>}
        <button className="btn primary big block">Work it out</button>
        <button type="button" className="btn quiet danger" onClick={onRemove}>
          Not paid this month
        </button>
      </form>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- employees */
function Employees() {
  const { data, error, reload } = useApi<Employee[]>('/api/employees');
  const [edit, setEdit] = useState<Employee | 'new' | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <div className="row">
        <button className="btn primary" onClick={() => setEdit('new')}>
          <Icon name="plus" size={18} />
          Add an employee
        </button>
      </div>
      {data.length ? (
        <section className="panel">
          <ul className="list">
            {data.map((e) => (
              <li key={e.id}>
                <button className={`list-row ${e.active ? '' : 'inactive'}`} onClick={() => setEdit(e)}>
                  <span className="grow">
                    <strong>{e.name}</strong> {e.isDirector && <span className="chip">director</span>}
                    <div className="xs muted">
                      Since {formatDate(e.startDate)}
                      {e.endDate ? ` · left ${formatDate(e.endDate)}` : ''}
                      {e.uif ? '' : ' · no UIF'}
                    </div>
                  </span>
                  <Money cents={e.salaryCents} />
                  <Icon name="chevronRight" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Empty title="No employees yet">Add the people on a monthly salary. Day-rate helpers go under Casual workers instead.</Empty>
      )}
      {edit && <EmployeeDrawer employee={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), void reload())} />}
    </div>
  );
}

function EmployeeDrawer({ employee: e, onClose, onSaved }: { employee: Employee | null; onClose: () => void; onSaved: () => void }) {
  const { settings, words } = useAuthed();
  const toast = useToast();
  const [f, setF] = useState({
    name: e?.name ?? '',
    idNumber: e?.idNumber ?? '',
    taxNumber: e?.taxNumber ?? '',
    isDirector: e?.isDirector ?? false,
    salaryCents: e?.salaryCents ?? (null as number | null),
    ageBand: e?.ageBand ?? ('under65' as AgeBand),
    medicalMembers: e?.medicalMembers ?? 0,
    uif: e?.uif ?? true,
    startDate: e?.startDate ?? todayIso(),
    endDate: e?.endDate ?? '',
    bankDetails: e?.bankDetails ?? '',
    active: e?.active ?? true,
  });
  const [error, setError] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const body = { ...f, salaryCents: f.salaryCents ?? 0, endDate: f.endDate || null };
    try {
      if (e) await api(`/api/employees/${e.id}`, { method: 'PUT', body });
      else await api('/api/employees', { body });
      toast('Saved');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title={e ? e.name : 'New employee'} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Name">{(p) => <input {...p} className="input" value={f.name} onChange={(x) => set('name', x.target.value)} required />}</Field>
        <Field label="Monthly salary (before tax)">{(p) => <MoneyInput {...p} value={f.salaryCents} onChange={(c) => set('salaryCents', c)} />}</Field>
        <div className="form-grid">
          <Field label="Started">{(p) => <input {...p} className="input" type="date" value={f.startDate} onChange={(x) => set('startDate', x.target.value)} required />}</Field>
          <Field label="Left (if they have)">{(p) => <input {...p} className="input" type="date" value={f.endDate} onChange={(x) => set('endDate', x.target.value)} />}</Field>
          <Field label="ID number" hint="13 digits (or a passport number): for their IRP5" error={idNumberProblem(f.idNumber) ?? undefined}>
            {(p) => <input {...p} className="input" inputMode="numeric" value={f.idNumber} onChange={(x) => set('idNumber', x.target.value)} />}
          </Field>
          <Field label="Income tax number" hint="10 digits: SARS rejects an EMP501 without it" error={taxNumberProblem(f.taxNumber) ?? undefined}>
            {(p) => <input {...p} className="input" inputMode="numeric" value={f.taxNumber} onChange={(x) => set('taxNumber', x.target.value)} />}
          </Field>
          <Field label="Age at the end of February" hint="Older employees get bigger rebates">
            {(p) => (
              <select {...p} className="select" value={f.ageBand} onChange={(x) => set('ageBand', x.target.value as AgeBand)}>
                {(Object.keys(AGE_BAND_LABELS) as AgeBand[]).map((a) => (
                  <option key={a} value={a}>
                    {AGE_BAND_LABELS[a]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="People on their medical aid" hint="Only if it’s paid through payroll; 0 if not">
            {(p) => <input {...p} className="input" type="number" min={0} max={20} value={f.medicalMembers} onChange={(x) => set('medicalMembers', Number(x.target.value))} />}
          </Field>
        </div>
        {entity(settings.businessType).payout !== 'drawings' && (
          <label className="check">
            <input type="checkbox" checked={f.isDirector} onChange={(x) => set('isDirector', x.target.checked)} />
            <span>
              {words.director}
              <div className="xs muted">Their pay goes to {words.directorAccount} in the books.</div>
            </span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={f.uif} onChange={(x) => set('uif', x.target.checked)} />
          <span>
            UIF applies
            <div className="xs muted">Untick for someone working under 24 hours a month, or a non-executive director. Ask your accountant if unsure.</div>
          </span>
        </label>
        <Field label="Their bank details (optional)">{(p) => <textarea {...p} className="textarea" rows={2} value={f.bankDetails} onChange={(x) => set('bankDetails', x.target.value)} />}</Field>
        {e && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(x) => set('active', x.target.checked)} />
            Still employed
          </label>
        )}
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
      </form>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- SARS */
interface SarsData {
  emp201: { period: string; payeCents: number; uifCents: number; sdlCents: number; totalCents: number; paidCents: number; dueOn: string }[];
  dividendsTax: { period: string; dwtCents: number; paidCents: number; dueOn: string }[];
}
function Sars() {
  const { ref, has } = useAuthed();
  const toast = useToast();
  const { data, error, reload } = useApi<SarsData>('/api/payroll/sars');
  const [pay, setPay] = useState<{ kind: 'emp201' | 'dwt'; period: string; owing: number } | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const today = todayIso();
  const row = (kind: 'emp201' | 'dwt', period: string, label: string, total: number, paid: number, dueOn: string) => {
    const owing = total - paid;
    return (
      <li key={`${kind}-${period}`} className="list-row">
        <span className="grow">
          <strong>{label}</strong>
          <div className={`xs ${owing > 0 && dueOn < today ? 'warn-text' : 'muted'}`}>
            {owing > 0 ? `${formatZar(owing)} due by ${formatDate(dueOn)}${dueOn < today ? ' (late)' : ''}` : `Paid ${formatZar(paid)}`}
          </div>
        </span>
        {owing > 0 && (
          <button className="btn small" onClick={() => setPay({ kind, period, owing })}>
            Paid SARS
          </button>
        )}
      </li>
    );
  };
  const empty = !data.emp201.length && !data.dividendsTax.length;
  return (
    <div className="stack">
      {empty ? (
        <Empty title="Nothing owed to SARS yet">After a pay run is final, its PAYE, UIF and SDL show here with the EMP201 due date.</Empty>
      ) : (
        <section className="panel">
          <ul className="list">
            {data.emp201.map((r) => row('emp201', r.period, `${monthName(r.period)}: PAYE ${formatZar(r.payeCents)}, UIF ${formatZar(r.uifCents)}${r.sdlCents ? `, SDL ${formatZar(r.sdlCents)}` : ''}`, r.totalCents, r.paidCents, r.dueOn))}
            {data.dividendsTax.map((r) => row('dwt', r.period, `Dividends tax, ${monthName(r.period)}`, r.dwtCents, r.paidCents, r.dueOn))}
          </ul>
        </section>
      )}
      <p className="xs muted">
        Declare and pay on SARS eFiling: the EMP201 each month (by the 7th), and the dividends tax return (DTR01/02) by the end of the month after a dividend. Then tap Paid SARS so the books match.
      </p>
      {has('payroll') && <Emp501 />}
      {pay && (
        <SarsPayDrawer
          pay={pay}
          sources={ref.sources.filter((s) => s.active && !s.role)}
          onClose={() => setPay(null)}
          onSaved={() => (setPay(null), void reload(), toast('Recorded'))}
        />
      )}
    </div>
  );
}

function SarsPayDrawer({ pay, sources, onClose, onSaved }: { pay: { kind: 'emp201' | 'dwt'; period: string; owing: number }; sources: { id: string; name: string; kind: string }[]; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState<number | null>(pay.owing);
  const [date, setDate] = useState(todayIso());
  const [sourceId, setSourceId] = useState(sources.find((s) => s.kind === 'bank')?.id ?? sources[0]?.id ?? '');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/sars-payments', { body: { kind: pay.kind, period: pay.period, date, amountCents: amount ?? 0, sourceId, reference } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title={pay.kind === 'emp201' ? `EMP201 ${monthName(pay.period)}` : `Dividends tax ${monthName(pay.period)}`} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Amount paid">{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
        <Field label="Date paid">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Paid from">
          {(p) => (
            <select {...p} className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="SARS payment reference (optional)">{(p) => <input {...p} className="input" value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
      </form>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- dividends */
interface Dividend {
  id: string;
  declaredOn: string;
  paidOn: string | null;
  shareholder: string;
  grossCents: number;
  dwtCents: number;
  netCents: number;
  exempt: boolean;
  sourceName: string | null;
}
function Dividends() {
  const { ref, settings, words } = useAuthed();
  const w = words;
  const kind = entity(settings.businessType);
  const toast = useToast();
  const { data, error, reload } = useApi<{ dividends: Dividend[]; availableCents: number }>('/api/dividends');
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState<Dividend | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <section className="panel panel-pad stack">
        <p className="small">
          Profits available to pay out: <strong>{formatZar(data.availableCents)}</strong>
          <span className="xs muted"> (all profit in the books, less {w.payout}s already made)</span>
        </p>
        <p className="xs muted">
          {kind.key === 'trust'
            ? 'Distributions follow the trust deed: the trustees decide them in writing. There’s no dividends tax. This year’s income given to a beneficiary living in South Africa is taxed in their hands, and the tax estimate takes it off the trust’s taxable income; given to someone abroad, the trust pays the tax.'
            : kind.key === 'cc'
              ? 'The members must be satisfied the CC stays solvent and can pay its debts after the distribution (Close Corporations Act, section 51). 20% dividends tax is withheld and paid to SARS; the member gets the rest.'
              : 'The directors must be satisfied the company stays solvent and can pay its debts after the dividend (Companies Act, section 46). 20% dividends tax is withheld and paid to SARS; the shareholder gets the rest.'}
        </p>
        <div>
          <button className="btn primary" onClick={() => setOpen(true)}>
            <Icon name="plus" size={18} />
            {kind.key === 'trust' ? 'Make a distribution' : `Declare a ${w.payout}`}
          </button>
        </div>
      </section>
      {data.dividends.length > 0 && (
        <section className="panel">
          <ul className="list">
            {data.dividends.map((d) => (
              <li key={d.id} className="list-row">
                <span className="grow">
                  <strong>{d.shareholder}</strong> · {formatZar(d.grossCents)}
                  <div className="xs muted">
                    Declared {formatDate(d.declaredOn)} ·{' '}
                    {d.paidOn ? `paid ${formatDate(d.paidOn)}${w.dividendsTax ? `: ${formatZar(d.netCents)} after ${d.exempt ? 'no' : formatZar(d.dwtCents)} dividends tax` : ''}` : 'not paid yet'}
                  </div>
                </span>
                {!d.paidOn && (
                  <button className="btn small" onClick={() => setPaying(d)}>
                    Paid
                  </button>
                )}
                <button
                  className="btn quiet small"
                  aria-label={`Delete ${w.payout}`}
                  onClick={() => confirm(`Delete this ${w.payout}? It comes out of the books.`) && void api(`/api/dividends/${d.id}`, { method: 'DELETE' }).then(reload).catch((e: Error) => toast(e.message, 'error'))}
                >
                  <Icon name="trash" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {open && <DividendDrawer available={data.availableCents} defaultName={settings.companyName ? 'You' : ''} onClose={() => setOpen(false)} onSaved={() => (setOpen(false), void reload(), toast(`${w.Payouts.slice(0, -1)} in the books`))} />}
      {paying && (
        <PayDividendDrawer
          d={paying}
          sources={ref.sources.filter((s) => s.active && !s.role)}
          onClose={() => setPaying(null)}
          onSaved={() => (setPaying(null), void reload())}
        />
      )}
    </div>
  );
}

function DividendDrawer({ available, defaultName, onClose, onSaved }: { available: number; defaultName: string; onClose: () => void; onSaved: () => void }) {
  const { ref, words: w } = useAuthed();
  const sources = ref.sources.filter((s) => s.active && !s.role);
  const [f, setF] = useState({ declaredOn: todayIso(), paidNow: true, shareholder: defaultName, grossCents: null as number | null, exempt: false, conduit: true, sourceId: sources.find((s) => s.kind === 'bank')?.id ?? sources[0]?.id ?? '', note: '' });
  const [error, setError] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const tax = f.exempt || !w.dividendsTax ? 0 : Math.round((f.grossCents ?? 0) * 0.2);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/dividends', {
        body: { declaredOn: f.declaredOn, paidOn: f.paidNow ? f.declaredOn : null, shareholder: f.shareholder, grossCents: f.grossCents ?? 0, exempt: f.exempt, conduit: f.conduit, sourceId: f.paidNow ? f.sourceId : null, note: f.note },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title={w.payout === 'dividend' ? 'Declare a dividend' : 'A distribution'} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label={`Paid to (${w.to})`}>{(p) => <input {...p} className="input" value={f.shareholder} onChange={(e) => set('shareholder', e.target.value)} required />}</Field>
        <Field label={w.dividendsTax ? `${w.Payouts.slice(0, -1)} (before tax)` : 'Amount'}>{(p) => <MoneyInput {...p} value={f.grossCents} onChange={(c) => set('grossCents', c)} />}</Field>
        {(f.grossCents ?? 0) > available && <div className="banner alert small">That’s more than the profits available ({formatZar(available)}). Check with your accountant first.</div>}
        <Field label="Declared on">{(p) => <input {...p} className="input" type="date" value={f.declaredOn} onChange={(e) => set('declaredOn', e.target.value)} />}</Field>
        {!w.dividendsTax && (
          <label className="check">
            <input type="checkbox" checked={f.conduit} onChange={(e) => set('conduit', e.target.checked)} />
            <span>
              This year’s income, to a beneficiary who lives in South Africa
              <div className="xs muted">Then it’s taxed in their hands and comes off the trust’s taxable income. Untick it for a beneficiary living abroad, or a distribution out of capital or earlier years’ income: the trust pays the tax on those.</div>
            </span>
          </label>
        )}
        {w.dividendsTax && (
          <label className="check">
            <input type="checkbox" checked={f.exempt} onChange={(e) => set('exempt', e.target.checked)} />
            <span>
              The {w.to} is a South African company
              <div className="xs muted">Then there’s no dividends tax (they must give you the exemption declaration).</div>
            </span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={f.paidNow} onChange={(e) => set('paidNow', e.target.checked)} />
          Paid the same day
        </label>
        {f.paidNow && (
          <Field label="Paid from">
            {(p) => (
              <select {...p} className="select" value={f.sourceId} onChange={(e) => set('sourceId', e.target.value)}>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {(f.grossCents ?? 0) > 0 && w.dividendsTax && (
          <p className="small">
            Dividends tax {formatZar(tax)} (to SARS) · the {w.to} gets <strong>{formatZar((f.grossCents ?? 0) - tax)}</strong>
          </p>
        )}
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Declare</button>
      </form>
    </Drawer>
  );
}

function PayDividendDrawer({ d, sources, onClose, onSaved }: { d: Dividend; sources: { id: string; name: string; kind: string }[]; onClose: () => void; onSaved: () => void }) {
  const [paidOn, setPaidOn] = useState(todayIso());
  const [sourceId, setSourceId] = useState(sources.find((s) => s.kind === 'bank')?.id ?? sources[0]?.id ?? '');
  const [error, setError] = useState('');
  return (
    <Drawer title={`Pay ${d.shareholder}`} sub={d.dwtCents ? `${formatZar(d.netCents)} after dividends tax` : formatZar(d.netCents)} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          api(`/api/dividends/${d.id}/pay`, { body: { paidOn, sourceId } })
            .then(onSaved)
            .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t save'));
        }}
      >
        <Field label="Paid on">{(p) => <input {...p} className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
        <Field label="Paid from">
          {(p) => (
            <select {...p} className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
      </form>
    </Drawer>
  );
}

interface Emp501Data {
  kind: 'interim' | 'annual';
  taxYear: number;
  from: string;
  to: string;
  window: { opens: string; closes: string };
  employer: { name: string; payeRef: string; sdlRef: string; uifRef: string; taxNumber: string; problems: string[] };
  months: { period: string; payeCents: number; uifCents: number; sdlCents: number; paidCents: number; totalCents: number }[];
  declared: { paye: number; uif: number; sdl: number; paid: number; total: number };
  employees: { id: string; name: string; certificate: 'IRP5' | 'IT3(a)'; taxNumber: string; periodFrom: string; periodTo: string; codes: Record<string, number>; problems: string[] }[];
  differences: { unpaidCents: number; payeCents: number; uifCents: number; sdlCents: number };
}

/**
 * The EMP501: the six-monthly reconciliation of the EMP201s against what was paid and the
 * employees' IRP5 / IT3(a) certificates. Shap prepares it; it's submitted on e@syFile or eFiling.
 */
function Emp501() {
  const now = todayIso();
  const thisYear = Number(now.slice(5, 7)) >= 3 ? Number(now.slice(0, 4)) + 1 : Number(now.slice(0, 4));
  // The one coming up: the annual for the year just ended (March to May), the interim (June to
  // October), then this year's annual.
  const m = Number(now.slice(5, 7));
  const [year, setYear] = useState(m >= 3 && m <= 5 ? thisYear - 1 : thisYear);
  const [kind, setKind] = useState<'interim' | 'annual'>(m >= 6 && m <= 10 ? 'interim' : 'annual');
  const { data, error, reload } = useApi<Emp501Data>(`/api/payroll/emp501?year=${year}&kind=${kind}`);
  const years = [thisYear, thisYear - 1, thisYear - 2];
  const off = data ? Object.entries(data.differences).filter(([, v]) => v !== 0) : [];
  return (
    <section className="panel stack">
      <div className="panel-head stack" style={{ gap: 4 }}>
        <strong>EMP501 reconciliation</strong>
        <span className="xs muted">
          Twice a year SARS checks your EMP201s against what you paid and each employee’s IRP5 (or IT3(a) when no tax was taken off): the interim for March to August (21 September to 31 October) and the
          annual for the whole tax year (1 April to 31 May).
        </span>
      </div>
      <div className="panel-pad stack" style={{ paddingTop: 0 }}>
        <div className="row wrap">
          <select className="select" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Tax year">
            {years.map((y) => (
              <option key={y} value={y}>
                Tax year to February {y}
              </option>
            ))}
          </select>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as 'interim' | 'annual')} aria-label="Which reconciliation">
            <option value="interim">Interim (March to August)</option>
            <option value="annual">Annual (March to February)</option>
          </select>
        </div>
        {error && <ErrorBox error={error} onRetry={reload} />}
        {!data && !error && <Loading />}
        {data && (
          <>
            <p className="small">
              {formatDate(data.from)} to {formatDate(data.to)}. File between {formatDate(data.window.opens)} and {formatDate(data.window.closes)}.
            </p>
            {data.employer.problems.map((p) => (
              <div key={p} className="banner alert small">
                {p}
              </div>
            ))}
            {data.months.length > 0 && <div className="table-wrap">
              <table className="table small">
                <thead>
                  <tr>
                    <th>EMP201 month</th>
                    <th className="num">PAYE</th>
                    <th className="num">UIF</th>
                    <th className="num">SDL</th>
                    <th className="num">Declared</th>
                    <th className="num">Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map((r) => (
                    <tr key={r.period}>
                      <td>{monthName(r.period)}</td>
                      <td className="num">{formatZar(r.payeCents)}</td>
                      <td className="num">{formatZar(r.uifCents)}</td>
                      <td className="num">{formatZar(r.sdlCents)}</td>
                      <td className="num">{formatZar(r.totalCents)}</td>
                      <td className={`num${r.paidCents !== r.totalCents ? ' warn-text' : ''}`}>{formatZar(r.paidCents)}</td>
                    </tr>
                  ))}
                  <tr>
                    <th>Total</th>
                    <th className="num">{formatZar(data.declared.paye)}</th>
                    <th className="num">{formatZar(data.declared.uif)}</th>
                    <th className="num">{formatZar(data.declared.sdl)}</th>
                    <th className="num">{formatZar(data.declared.total)}</th>
                    <th className="num">{formatZar(data.declared.paid)}</th>
                  </tr>
                </tbody>
              </table>
            </div>}
            {!data.months.length && <p className="small muted">No final pay runs in this period.</p>}
            {off.length > 0 ? (
              <div className="banner alert small">
                Doesn’t reconcile yet:{' '}
                {off
                  .map(([k, v]) => (k === 'unpaidCents' ? `${formatZar(v)} declared but not recorded as paid` : `${k.replace('Cents', '').toUpperCase()} on the certificates differs by ${formatZar(v)}`))
                  .join('; ')}
                . Record SARS payments above, or check the pay runs.
              </div>
            ) : (
              data.months.length > 0 && <div className="banner small">Declared, paid and the certificates agree.</div>
            )}
            <ul className="list">
              {data.employees.map((e) => (
                <li key={e.id} className="list-row">
                  <span className="grow">
                    <strong>{e.name}</strong> <span className="chip">{e.certificate}</span>
                    <div className="xs muted">
                      Gross {formatZar(e.codes['3699'] ?? 0)} · PAYE {formatZar(e.codes['4102'] ?? 0)} · UIF {formatZar(e.codes['4141'] ?? 0)}
                      {(e.codes['4142'] ?? 0) > 0 ? ` · SDL ${formatZar(e.codes['4142'] ?? 0)}` : ''}
                    </div>
                    {e.problems.map((p) => (
                      <div key={p} className="xs warn-text">
                        {p}
                      </div>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
            <FileButton className="btn" path={`/api/payroll/emp501?year=${year}&kind=${kind}&format=csv`} title={`EMP501 ${kind} ${year}`}>
              <Icon name="share" size={16} />
              Certificates with SARS’s source codes (CSV)
            </FileButton>
            <p className="xs muted">
              Capture these on e@syFile Employer (or eFiling, up to 50 certificates) and submit the EMP501 by the closing date. The figures come from your final pay runs and the payments you recorded:
              check them with your accountant before you submit.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
