/** Monthly invoices: a copy of the latest one is made on its day each month, then emailed or left as a draft. */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatZar, todayIso } from '@shap/shared';
import { Drawer, Field, Icon, Segmented, useToast } from './ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';

export interface MonthlySchedule {
  id: string;
  sourceId: string;
  dayOfMonth: number;
  startsOn: string;
  endsOn: string | null;
  mode: 'send' | 'draft';
  emailTo: string;
  message: string;
  active: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
  title: string;
  totalCents: number;
  clientName: string | null;
  brandName: string | null;
  latest: { id: string; number: string; issueDate: string; status: string; sentAt: string | null; totalCents: number } | null;
  made: number;
  nextDate: string | null;
}

const ym = (d: string) => d.slice(0, 7);
const nextMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};
/** The day in that month, or its last day for short months (31 → 28 Feb). */
const dayIn = (m: string, day: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m}-${String(Math.min(Math.max(day, 1), last)).padStart(2, '0')}`;
};
/** When the first one would be made, the same way the server works it out. */
function firstDate(lastMonth: string, day: number, startsOn: string, endsOn: string | null) {
  let m = nextMonth(lastMonth);
  if (ym(startsOn) > m) m = ym(startsOn);
  for (let i = 0; i < 24; i++, m = nextMonth(m)) {
    const d = dayIn(m, day);
    if (d < startsOn) continue;
    if (endsOn && d > endsOn) return null;
    return d;
  }
  return null;
}

const describe = (s: MonthlySchedule) => (s.mode === 'send' ? `emailed to ${s.emailTo}` : 'made as a draft for you to check and send');

/** On an invoice: make it monthly, or see and change the series it's in. */
export interface MonthlyState {
  schedule: MonthlySchedule | null;
  emailOn: boolean;
}

/** The drawer has a form of its own, so it's opened by the page, outside the invoice's form. */
export function MonthlyPanel({ doc, data, reload, onChange }: { doc: { id: string }; data: MonthlyState; reload: () => Promise<void>; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const s = data.schedule;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  const setActive = (active: boolean) =>
    act(async () => {
      await api(`/api/monthly-invoices/${s!.id}`, {
        method: 'PUT',
        body: { dayOfMonth: s!.dayOfMonth, startsOn: active ? laterOf(s!.startsOn, todayIso()) : s!.startsOn, endsOn: s!.endsOn, mode: s!.mode, emailTo: s!.emailTo, message: s!.message, active },
      });
      toast(active ? 'Monthly invoice started again' : 'Monthly invoice stopped');
    });
  const runNow = () =>
    act(async () => {
      const r = await api<{ created: number; emailed: number; failed: number }>(`/api/monthly-invoices/${s!.id}/run`, { body: {} });
      if (r.failed) return;
      toast(r.created || r.emailed ? `${r.created ? `${r.created} made` : ''}${r.created && r.emailed ? ', ' : ''}${r.emailed ? `${r.emailed} emailed` : ''}` : `Nothing due yet${s!.nextDate ? `: the next one is on ${formatDate(s!.nextDate)}` : ''}`);
    });

  return (
    <section className="panel panel-pad stack" style={{ gap: 10 }}>
      {!s ? (
        <>
          <div className="row spread">
            <strong>Monthly</strong>
          </div>
          <p className="small muted">Bill this every month: on its day Shap makes a copy of the latest one, with the month brought up to date, and emails it or leaves it as a draft for you.</p>
          <button type="button" className="btn block" onClick={onChange}>
            <Icon name="calendar" size={18} />
            Make monthly…
          </button>
        </>
      ) : (
        <>
          <div className="row spread">
            <strong>Monthly</strong>
            <span className={`chip${s.active ? ' d-issued' : ''}`}>{s.active ? 'On' : 'Stopped'}</span>
          </div>
          {s.active ? (
            <p className="small">
              {s.nextDate ? (
                <>
                  Next one on <strong>{formatDate(s.nextDate)}</strong>, {describe(s)}.
                </>
              ) : (
                <>No more to make{s.endsOn ? ` (it ended ${formatDate(s.endsOn)})` : ''}.</>
              )}
              {s.endsOn && s.nextDate && <> Last one by {formatDate(s.endsOn)}.</>}
            </p>
          ) : (
            <p className="small muted">Stopped. Nothing more will be made until it’s started again.</p>
          )}
          <p className="xs muted">
            {s.made > 1 ? `${s.made} so far. ` : ''}Each is a copy of the latest one: change the latest invoice and the next ones follow.
            {s.latest && s.latest.id !== doc.id && (
              <>
                {' '}
                Latest: <Link to={`/documents/${s.latest.id}`}>{s.latest.number}</Link> ({formatDate(s.latest.issueDate)}).
              </>
            )}
          </p>
          {s.active && s.lastError && (
            <div className="banner alert small">
              <strong>Last try didn’t work:</strong> {s.lastError}
              {s.lastErrorAt ? ` (${formatDate(s.lastErrorAt.slice(0, 10))})` : ''}. Fix it, then Try again.
            </div>
          )}
          {s.active && s.mode === 'send' && !data.emailOn && !s.lastError && (
            <div className="banner alert small">Email isn’t set up on this server yet, so these will be made but not sent.</div>
          )}
          {error && <div className="banner alert small">{error}</div>}
          <div className="row wrap">
            <button type="button" className="btn small" onClick={onChange} disabled={busy}>
              <Icon name="edit" size={16} />
              Change
            </button>
            {s.active && (
              <button type="button" className="btn small" onClick={() => void runNow()} disabled={busy}>
                {s.lastError ? 'Try again' : 'Do what’s due now'}
              </button>
            )}
            {s.active ? (
              <button type="button" className="btn quiet small danger" onClick={() => confirm('Stop making this invoice every month? The ones already made stay as they are.') && void setActive(false)} disabled={busy}>
                Stop
              </button>
            ) : (
              <button type="button" className="btn quiet small" onClick={() => void setActive(true)} disabled={busy}>
                Start again
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

const laterOf = (a: string, b: string) => (a > b ? a : b);
const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

export function MonthlyDrawer({
  doc,
  schedule: s,
  emailOn,
  onClose,
  onSaved,
}: {
  doc: { id: string; number: string; issueDate: string; clientEmail: string | null; brandName?: string | null };
  schedule: MonthlySchedule | null;
  emailOn: boolean;
  onClose: () => void;
  onSaved: (s: MonthlySchedule) => void;
}) {
  const [day, setDay] = useState(String(s?.dayOfMonth ?? Number(doc.issueDate.slice(8, 10))));
  // Never from the past: an old invoice made monthly today mustn't make the months in between.
  const [startsOn, setStartsOn] = useState(s ? laterOf(s.startsOn, todayIso()) : laterOf(addDay(doc.issueDate), todayIso()));
  const [endsOn, setEndsOn] = useState(s?.endsOn ?? '');
  const [mode, setMode] = useState<'send' | 'draft'>(s?.mode ?? 'send');
  const [emailTo, setEmailTo] = useState(s?.emailTo || doc.clientEmail || '');
  const [message, setMessage] = useState(s?.message ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const dayN = Math.min(Math.max(Math.round(Number(day)) || 1, 1), 31);
  const lastMonth = ym(s?.latest?.issueDate ?? doc.issueDate);
  const first = firstDate(lastMonth, dayN, startsOn, endsOn || null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = { dayOfMonth: dayN, startsOn, endsOn: endsOn || null, mode, emailTo: emailTo.trim(), message };
    try {
      const saved = s
        ? await api<MonthlySchedule>(`/api/monthly-invoices/${s.id}`, { method: 'PUT', body: { ...body, active: true } })
        : await api<MonthlySchedule>(`/api/documents/${doc.id}/monthly`, { body });
      onSaved(saved);
      toast(s ? 'Monthly invoice updated' : `Monthly from ${saved.nextDate ? formatDate(saved.nextDate) : 'next month'}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={s ? 'Monthly invoice' : `Make ${doc.number} monthly`} sub="A copy of the latest invoice, each month" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Day of the month" hint="Short months use their last day">
            {(p) => <input {...p} className="input" type="number" inputMode="numeric" min={1} max={31} value={day} onChange={(e) => setDay(e.target.value)} required />}
          </Field>
          <Field label="Starting from">{(p) => <input {...p} className="input" type="date" value={startsOn} min={s ? undefined : todayIso()} onChange={(e) => setStartsOn(e.target.value)} required />}</Field>
        </div>
        <p className="small">{first ? <>The {s ? 'next' : 'first'} one: <strong>{formatDate(first)}</strong>.</> : 'None would be made: the end date is before the next one.'}</p>
        <Field label="Then">
          {() => (
            <Segmented
              label="Then"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'send', label: 'Email it' },
                { value: 'draft', label: 'Draft for me to check' },
              ]}
            />
          )}
        </Field>
        {mode === 'send' ? (
          <>
            <Field label="Email to" hint={`From ${doc.brandName || 'your trading name'}; replies come to your email. The PDF is attached.`}>
              {(p) => <input {...p} className="input" type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} required />}
            </Field>
            {!emailOn && <div className="banner alert small">Email isn’t set up on this server yet. Until it is, these are made and issued but not sent, and Home tells you.</div>}
          </>
        ) : (
          <p className="small muted">On its day the invoice is made as a draft and Home reminds you. Check it, issue it, then send it as usual.</p>
        )}
        {mode === 'send' && (
          <Field label="Message (optional)" hint="Leave blank for a short standard note. A month like “October 2026” here, in the heading or in the lines is moved to each invoice’s month.">
            {(p) => <textarea {...p} className="textarea" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />}
          </Field>
        )}
        <Field label="Last one by (optional)" hint="Leave blank to carry on until you stop it">
          {(p) => <input {...p} className="input" type="date" value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} />}
        </Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block" disabled={busy}>
          {busy ? 'Saving…' : s ? 'Save' : 'Make monthly'}
        </button>
      </form>
    </Drawer>
  );
}

/** On the invoices list: what's billed every month. */
export function MonthlyList() {
  const { data } = useApi<MonthlySchedule[]>('/api/monthly-invoices');
  const [open, setOpen] = useState(false);
  if (!data?.length) return null;
  const on = data.filter((s) => s.active);
  return (
    <section className="panel">
      <button type="button" className="panel-head spread strong" style={{ width: '100%', background: 'none', border: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          Monthly invoices <span className="muted small">({on.length} on{data.length > on.length ? `, ${data.length - on.length} stopped` : ''})</span>
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
      </button>
      {open && (
        <ul className="list">
          {data.map((s) => (
            <li key={s.id}>
              <Link to={`/documents/${s.latest?.id ?? s.sourceId}`} className="list-row">
                <span className="grow small">
                  <strong>{s.clientName ?? 'No client'}</strong> · {s.title || 'Invoice'}
                  <div className="xs muted">
                    {!s.active ? 'Stopped' : s.nextDate ? `Next ${formatDate(s.nextDate)}, ${s.mode === 'send' ? `emailed to ${s.emailTo}` : 'as a draft'}` : 'Ended'}
                    {s.active && s.lastError ? ' · last try didn’t work' : ''}
                  </div>
                </span>
                <span className="small">{formatZar(s.latest?.totalCents ?? s.totalCents)}</span>
                <Icon name="chevronRight" size={16} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
