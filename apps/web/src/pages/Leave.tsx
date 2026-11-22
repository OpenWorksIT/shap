/**
 * Payroll → Leave: every kind of leave the BCEA gives (and unpaid or other leave), each person's
 * balances worked out from what's recorded, and the annual leave pay owed at a year end for the
 * books. docs/LEAVE.md.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { FAMILY_REASONS, formatDate, formatDays, formatZar, LEAVE_KIND_INFO, LEAVE_KINDS, PARENT_KINDS, PARENT_NOTE, todayIso, type FamilyReason, type LeaveBalances, type LeaveEmployee, type LeaveKind } from '@shap/shared';
import { Drawer, Empty, ErrorBox, Field, Icon, Loading, Money, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { UNEXPECTED } from '../lib/words';

interface Person {
  id: string;
  name: string;
  isDirector: boolean;
  startDate: string;
  endDate: string | null;
  terms: LeaveEmployee;
  balances: LeaveBalances;
  warnings: string[];
}
interface Entry {
  id: string;
  employeeId: string;
  kind: LeaveKind;
  adjustment: boolean;
  fromDate: string;
  toDate: string;
  days: number;
  paid: boolean;
  certificate: boolean;
  reason: '' | FamilyReason;
  note: string;
}
interface PayOwed {
  fy: { start: string; end: string; label: string };
  ended: boolean;
  locked: boolean;
  owed: { on: string; cents: number; people: { employeeId: string; name: string; days: number; dayCents: number; cents: number; left: boolean }[] };
  booked: { owedCents: number; createdAt: string } | null;
  booksCents: number;
}

/** What the balances rest on, wherever they show. */
export const LEAVE_NOTE =
  'Worked out from the leave recorded here and the BCEA’s least (three weeks’ annual leave a year, six weeks’ sick leave in three years, three family responsibility days a year), with what each person’s terms add. A sectoral determination, a bargaining council or their contract can give more: set it on the employee. Shap keeps the records and does the sums; it isn’t a labour adviser, so check what applies to your business with yours.';

export function LeaveTab() {
  const { data, error, reload } = useApi<{ on: string; people: Person[] }>('/api/leave');
  const [record, setRecord] = useState<{ employeeId?: string; entry?: Entry } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const people = data.people;
  return (
    <div className="stack">
      {people.length > 0 && (
        <div className="row">
          <button className="btn primary" onClick={() => setRecord({})}>
            <Icon name="plus" size={18} />
            Record leave
          </button>
        </div>
      )}
      {people.length ? (
        <section className="panel">
          <ul className="list">
            {people.map((p) => {
              const b = p.balances;
              const left = Boolean(p.endDate && p.endDate < data.on);
              return (
                <li key={p.id}>
                  <button className={`list-row ${left ? 'inactive' : ''}`} onClick={() => setOpen(p.id)}>
                    <span className="grow">
                      <strong>{p.name}</strong> {left && <span className="chip">left</span>}
                      <div className="xs muted">
                        Annual leave owed {formatDays(b.annual.owedDays)} · sick leave left {formatDays(b.sick.leftDays)}
                        {b.family.eligible ? ` · family responsibility left ${formatDays(b.family.leftDays)}` : ''}
                      </div>
                      {p.warnings.length > 0 && (
                        <div className="xs">
                          <Icon name="alert" size={12} /> {p.warnings.length === 1 ? 'One thing' : `${p.warnings.length} things`} to look at
                        </div>
                      )}
                    </span>
                    <Icon name="chevronRight" size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <Empty title="No employees yet">Add the people on a salary under Employees, then record their leave here: Shap keeps each balance.</Empty>
      )}
      {people.length > 0 && <LeavePayOwed />}
      <p className="xs muted">{LEAVE_NOTE}</p>
      {record && <LeaveDrawer people={people} employeeId={record.employeeId} entry={record.entry} onClose={() => setRecord(null)} onSaved={() => (setRecord(null), void reload())} />}
      {open && !record && <PersonLeave id={open} onClose={() => (setOpen(null), void reload())} onRecord={(entry) => setRecord({ employeeId: open, entry })} />}
    </div>
  );
}

/* ---------------------------------------------------------------- one person */
function PersonLeave({ id, onClose, onRecord }: { id: string; onClose: () => void; onRecord: (entry?: Entry) => void }) {
  const { data, error, reload } = useApi<{ name: string; terms: LeaveEmployee; balances: LeaveBalances; warnings: string[]; entries: Entry[]; paidOut: { date: string; days: number }[] }>(`/api/leave/employee/${id}`, { fresh: true });
  useEffect(() => void reload(), [reload]);
  if (error) return <Drawer title="Leave" onClose={onClose}><ErrorBox error={error} onRetry={reload} /></Drawer>;
  if (!data) return <Drawer title="Leave" onClose={onClose}><Loading /></Drawer>;
  const { balances: b, terms: t } = data;
  const row = (label: string, value: string) => (
    <tr>
      <td>{label}</td>
      <td className="num">{value}</td>
    </tr>
  );
  return (
    <Drawer title={data.name} sub={`Leave on ${formatDate(b.on)}`} onClose={onClose} wide>
      <div className="stack">
        {data.warnings.map((w) => (
          <div key={w} className="banner signal small">{w}</div>
        ))}
        <div className="row">
          <button className="btn primary" onClick={() => onRecord()}>
            <Icon name="plus" size={18} />
            Record leave for {data.name}
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr className="sub"><td colSpan={2}>Annual leave (year to {formatDate(b.annual.cycle.end)})</td></tr>
              {row(t.openingDate && t.openingDate > t.startDate ? `Earned since ${formatDate(t.openingDate)} (with ${formatDays(t.openingAnnualDays)} owed then)` : `Earned since ${formatDate(t.startDate)}`, formatDays(b.annual.earnedDays))}
              {row('Taken', formatDays(b.annual.takenDays))}
              {b.annual.adjustedDays !== 0 && row('Adjusted', formatDays(b.annual.adjustedDays))}
              {b.annual.paidOutDays > 0 && row('Paid out on leaving', formatDays(b.annual.paidOutDays))}
              {row('Owed', formatDays(b.annual.owedDays))}
              <tr className="sub"><td colSpan={2}>Sick leave ({b.sick.firstSixMonths ? 'first six months: a day for every 26 worked' : `cycle ${formatDate(b.sick.cycle.start)} to ${formatDate(b.sick.cycle.end)}`})</td></tr>
              {row('Paid sick leave in the cycle', formatDays(b.sick.allowedDays))}
              {row('Taken', formatDays(b.sick.takenDays))}
              {row('Left', formatDays(b.sick.leftDays))}
              <tr className="sub"><td colSpan={2}>Family responsibility leave (year to {formatDate(b.family.cycle.end)})</td></tr>
              {b.family.eligible ? (
                <>
                  {row('This year', formatDays(b.family.allowedDays))}
                  {row('Taken', formatDays(b.family.takenDays))}
                  {row('Left', formatDays(b.family.leftDays))}
                </>
              ) : (
                row('After four months, for someone working at least four days a week', b.family.takenDays ? `${formatDays(b.family.takenDays)} taken` : 'not yet')
              )}
              {LEAVE_KINDS.filter((k) => !['annual', 'sick', 'family'].includes(k) && b.thisCycle[k] > 0).map((k) => row(`${LEAVE_KIND_INFO[k].label} this year`, formatDays(b.thisCycle[k])))}
            </tbody>
          </table>
        </div>
        <p className="xs muted">
          {t.daysPerWeek} days a week · {formatDays(t.annualDays)} annual leave a year · {formatDays(t.familyDays)} family responsibility leave a year. Change these under Employees.
        </p>
        <h3>What’s recorded</h3>
        {data.entries.length ? (
          <ul className="list panel">
            {data.entries.map((x) => (
              <li key={x.id}>
                <button className="list-row" onClick={() => onRecord(x)}>
                  <span className="grow">
                    <strong>{x.adjustment ? 'Annual leave adjusted' : LEAVE_KIND_INFO[x.kind].label}</strong>
                    <div className="xs muted">
                      {x.adjustment ? formatDate(x.fromDate) : x.fromDate === x.toDate ? formatDate(x.fromDate) : `${formatDate(x.fromDate)} to ${formatDate(x.toDate)}`}
                      {!x.adjustment && !x.paid ? ' · unpaid' : ''}
                      {x.kind === 'sick' && x.certificate ? ' · certificate' : ''}
                      {x.reason ? ` · ${FAMILY_REASONS[x.reason].toLowerCase()}` : ''}
                      {x.note ? ` · ${x.note}` : ''}
                    </div>
                  </span>
                  <span className="num">{x.adjustment && x.days > 0 ? '+' : ''}{formatDays(x.days)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No leave recorded yet.</p>
        )}
      </div>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- recording leave */
function LeaveDrawer({ people, employeeId, entry, onClose, onSaved }: { people: Person[]; employeeId?: string; entry?: Entry; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const today = todayIso();
  const [f, setF] = useState({
    employeeId: entry?.employeeId ?? employeeId ?? people.find((p) => !p.endDate || p.endDate >= today)?.id ?? people[0]?.id ?? '',
    kind: (entry?.kind ?? 'annual') as LeaveKind,
    adjustment: entry?.adjustment ?? false,
    fromDate: entry?.fromDate ?? today,
    toDate: entry?.toDate ?? today,
    days: entry ? String(entry.days) : '',
    paid: entry?.paid ?? true,
    certificate: entry?.certificate ?? false,
    reason: (entry?.reason ?? '') as '' | FamilyReason,
    note: entry?.note ?? '',
  });
  const [typed, setTyped] = useState(Boolean(entry));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  // The working days between the dates (public holidays left out), until the days are typed.
  useEffect(() => {
    if (typed || f.adjustment || !f.employeeId || f.toDate < f.fromDate) return;
    let gone = false;
    void api<{ days: number }>(`/api/leave/days?employeeId=${f.employeeId}&from=${f.fromDate}&to=${f.toDate}`)
      .then((r) => !gone && setF((x) => ({ ...x, days: String(r.days) })))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [f.employeeId, f.fromDate, f.toDate, f.adjustment, typed]);
  const chooseKind = (k: LeaveKind) => setF((x) => ({ ...x, kind: k, paid: LEAVE_KIND_INFO[k].paid, adjustment: k === 'annual' ? x.adjustment : false }));
  const person = people.find((p) => p.id === f.employeeId);
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { ...f, toDate: f.adjustment ? f.fromDate : f.toDate, days: Number(f.days) };
      const r = await api<{ finalRuns?: string[] }>(entry ? `/api/leave/${entry.id}` : '/api/leave', { method: entry ? 'PUT' : 'POST', body });
      const runs = r.finalRuns ?? [];
      toast(runs.length ? `Saved. The pay run for ${runs.join(', ')} is final: reopen it to take the unpaid days off` : 'Saved');
      onSaved();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      setError(err instanceof ApiError ? err.message : UNEXPECTED);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!entry || !confirm('Delete this leave? The balances and any draft pay run change with it.')) return;
    setBusy(true);
    try {
      await api(`/api/leave/${entry.id}`, { method: 'DELETE' });
      toast('Deleted');
      onSaved();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      setError(err instanceof ApiError ? err.message : UNEXPECTED);
    } finally {
      setBusy(false);
    }
  };
  const b = person?.balances;
  return (
    <Drawer title={entry ? 'Change leave' : 'Record leave'} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Who">
          {(p) => (
            <select {...p} className="select" value={f.employeeId} disabled={Boolean(entry)} onChange={(e) => set('employeeId', e.target.value)}>
              {people.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Kind of leave" hint={`${LEAVE_KIND_INFO[f.kind].hint} (${LEAVE_KIND_INFO[f.kind].law})`}>
          {(p) => (
            <select {...p} className="select" value={f.kind} onChange={(e) => chooseKind(e.target.value as LeaveKind)}>
              {LEAVE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LEAVE_KIND_INFO[k].label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {f.kind === 'annual' && (
          <label className="check">
            <input type="checkbox" checked={f.adjustment} onChange={(e) => set('adjustment', e.target.checked)} />
            <span>
              An adjustment, not leave taken
              <div className="xs muted">Days added (or, with a minus, taken off) with the reason: a correction, extra days given, or leave paid some other way.</div>
            </span>
          </label>
        )}
        <div className="form-grid">
          <Field label={f.adjustment ? 'On' : 'First day'}>{(p) => <input {...p} className="input" type="date" value={f.fromDate} onChange={(e) => setF((x) => ({ ...x, fromDate: e.target.value, toDate: x.toDate < e.target.value ? e.target.value : x.toDate }))} required />}</Field>
          {!f.adjustment && <Field label="Last day">{(p) => <input {...p} className="input" type="date" value={f.toDate} min={f.fromDate} onChange={(e) => set('toDate', e.target.value)} required />}</Field>}
          <Field label={f.adjustment ? 'Days added (minus to take off)' : 'Working days'} hint={f.adjustment ? undefined : 'Worked out from the dates, public holidays left out: change it for half days or other working days'}>
            {(p) => <input {...p} className="input" type="number" step={0.5} value={f.days} onChange={(e) => (setTyped(true), set('days', e.target.value))} required />}
          </Field>
        </div>
        {!f.adjustment && (
          <label className="check">
            <input type="checkbox" checked={f.paid} onChange={(e) => set('paid', e.target.checked)} />
            <span>
              Paid leave
              <div className="xs muted">Untick for unpaid days: they come off that month’s pay run at a day’s pay.</div>
            </span>
          </label>
        )}
        {f.kind === 'sick' && (
          <label className="check">
            <input type="checkbox" checked={f.certificate} onChange={(e) => set('certificate', e.target.checked)} />
            <span>
              They handed in a medical certificate
              <div className="xs muted">The BCEA lets you ask for one after more than two days in a row, or more than two times in eight weeks (s23).</div>
            </span>
          </label>
        )}
        {f.kind === 'family' && (
          <Field label="What for">
            {(p) => (
              <select {...p} className="select" value={f.reason} onChange={(e) => set('reason', e.target.value as '' | FamilyReason)} required>
                <option value="">Choose</option>
                {(Object.keys(FAMILY_REASONS) as FamilyReason[]).map((r) => (
                  <option key={r} value={r}>
                    {FAMILY_REASONS[r]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label={f.adjustment ? 'Why' : 'Note (optional)'} hint={f.kind === 'sick' ? 'Don’t write what the illness is: that’s their health information' : undefined}>
          {(p) => <input {...p} className="input" value={f.note} onChange={(e) => set('note', e.target.value)} required={f.adjustment} />}
        </Field>
        {PARENT_KINDS.includes(f.kind) && <p className="xs muted">{PARENT_NOTE}</p>}
        {b && !f.adjustment && f.kind === 'annual' && <p className="xs muted">{person!.name} has {formatDays(b.annual.owedDays)} of annual leave owed today.</p>}
        {b && f.kind === 'sick' && <p className="xs muted">{person!.name} has {formatDays(b.sick.leftDays)} of paid sick leave left in this cycle. More than that can be unpaid, or taken as annual leave if you both agree.</p>}
        {b && f.kind === 'family' && <p className="xs muted">{b.family.eligible ? `${person!.name} has ${formatDays(b.family.leftDays)} of family responsibility leave left this year.` : 'The BCEA gives family responsibility leave after four months, to someone who works at least four days a week: before then it’s by agreement.'}</p>}
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block" disabled={busy}>Save</button>
        {entry && (
          <button type="button" className="btn quiet danger" disabled={busy} onClick={() => void remove()}>
            Delete this leave
          </button>
        )}
      </form>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- leave pay owed at the year end */
function LeavePayOwed() {
  const { isOwner } = useAuthed();
  const toast = useToast();
  const [fyEnd, setFyEnd] = useState<string | undefined>(undefined);
  const { data, error, reload } = useApi<PayOwed>(`/api/leave/pay-owed${fyEnd ? `?fyEnd=${fyEnd}` : ''}`, { fresh: true });
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const same = data.booked && data.booked.owedCents === data.owed.cents;
  const book = async () => {
    setBusy(true);
    try {
      const r = await api<{ alsoBooked: string[] }>('/api/leave/pay-owed', { body: { fyEnd: data.fy.end } });
      toast(r.alsoBooked.length ? `Booked, and the later year ends again (${r.alsoBooked.map((d) => formatDate(d)).join(', ')})` : 'Booked: it’s in the books at the year end');
      await reload();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
    } finally {
      setBusy(false);
    }
  };
  const previous = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4, 8)}${new Date(Date.UTC(Number(iso.slice(0, 4)) - 1, Number(iso.slice(5, 7)), 0)).getUTCDate()}`;
  return (
    <section className="panel panel-pad stack">
      <div className="row wrap">
        <h3 className="grow">Leave pay owed at {formatDate(data.fy.end, 'long')}</h3>
        <select className="select" aria-label="Year end" value={data.fy.end} onChange={(e) => setFyEnd(e.target.value)}>
          {[data.fy.end, previous(data.fy.end), previous(previous(data.fy.end))].map((d) => (
            <option key={d} value={d}>
              {formatDate(d, 'long')}
            </option>
          ))}
        </select>
      </div>
      {data.owed.people.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th className="num">Annual leave owed</th>
                <th className="num hide-sm">A day’s pay</th>
                <th className="num">Owed</th>
              </tr>
            </thead>
            <tbody>
              {data.owed.people.map((p) => (
                <tr key={p.employeeId}>
                  <td>
                    {p.name}
                    {p.left && <div className="xs muted">left, not yet paid out</div>}
                  </td>
                  <td className="num">{formatDays(p.days)}</td>
                  <td className="num hide-sm"><Money cents={p.dayCents} /></td>
                  <td className="num"><Money cents={p.cents} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="sub">
                <td colSpan={3}>Leave pay owed</td>
                <td className="num"><Money cents={data.owed.cents} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p className="small muted">No annual leave owed at the year end, by the leave records.</p>
      )}
      <p className="small">
        {data.booked
          ? same
            ? `In the books: ${formatZar(data.booked.owedCents)}, booked ${formatDate(data.booked.createdAt.slice(0, 10))}.`
            : `${formatZar(data.booked.owedCents)} was booked on ${formatDate(data.booked.createdAt.slice(0, 10))}; the leave records now show ${formatZar(data.owed.cents)}. Book it again to put that in the books.`
          : data.ended
            ? `Not in the books yet. Leave pay owed in the books at the year end: ${formatZar(data.booksCents)}.`
            : 'The year hasn’t ended: book it once it has.'}
      </p>
      {isOwner && data.ended && !data.locked && !same && (data.owed.cents !== 0 || data.booked || data.booksCents !== 0) && (
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => void book()}>
            {data.booked ? 'Book it again' : 'Book it in the books'}
          </button>
        </div>
      )}
      {data.locked && <p className="xs muted">That year is closed: reopening it (Accounts → Locks) comes first.</p>}
      <p className="xs muted">
        Annual leave owed at a year end is a liability in the books (IFRS for SMEs 28.6), at each person’s day’s pay then (BCEA s35), not discounted: Shap books the year’s change against salaries (a director’s against their remuneration). Sick, family responsibility and parents’ leave aren’t paid out, so nothing is owed for them. For tax, leave pay counts only once it’s paid (Income Tax Act s7B): Shap’s tax estimates add the year’s increase back. A figure from the leave records, for your accountant to check.
      </p>
    </section>
  );
}
