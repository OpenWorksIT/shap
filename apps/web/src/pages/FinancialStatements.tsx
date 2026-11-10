/**
 * The annual financial statements, on the Accounts screen: Shap Pocket drafts them from the
 * books (IFRS for SMEs), you share the draft with your accountant, upload their signed compiler's
 * report when it comes back, and approve them, which agrees and closes the year. (Full Shap also
 * has the accountant sign in and compile there.) A signed set is frozen at its figures: if the
 * books move afterwards, the app says so and the set has to go back to the accountant.
 */
import { useState, type FormEvent } from 'react';
import {
  ASSURANCE,
  ASSURANCE_LABELS,
  ESTIMATE_NOTE,
  ESTIMATE_SHORT,
  formatDate,
  POLICY_KEYS,
  POLICY_LABELS,
  STATEMENT_STATUS_LABELS,
  todayIso,
  type Assurance,
  type PolicyKey,
  type StatementDetailsInput,
  type StatementStatus,
} from '@shap/shared';
import { PdfPreview } from '../components/PdfPreview';
import { Drawer, Empty, ErrorBox, Field, Icon, Kpi, Loading, Money, useToast } from '../components/ui';
import { api, ApiError, apiBlob } from '../lib/api';
import { sharePdf } from '../lib/share-pdf';
import { compressSlip } from '../lib/files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';

interface Year {
  fyEnd: string;
  fyStart: string;
  status: StatementStatus;
  agreed: boolean;
  compiledOn: string | null;
  approvedOn: string | null;
}
interface Amounts {
  current: number;
  prior: number;
}
interface StatementsView {
  statements: {
    fyEnd: string;
    period: string;
    title: string;
    hasPrior: boolean;
    governing: { one: string; many: string; signs: string };
    details: StatementDetailsInput;
    sfp: { totalAssets: Amounts; totalLiabilities: Amounts; equity: Amounts & { label: string }; totalEquityAndLiabilities: Amounts };
    sci: { revenue: (Amounts & { label: string })[]; grossProfit: Amounts; profit: Amounts };
    scf: { netChange: Amounts; closing: Amounts };
    checks: { label: string; ok: boolean; detail: string; level?: 'look' }[];
    policyDefaults?: Record<PolicyKey, string>;
    company: { businessType: string };
    taxEstimate?: { profitCents: number; assessedLossCents: number; taxableCents: number; taxCents: number; sbc: boolean | null; sbcTaxCents?: number; standardTaxCents?: number } | null;
    publicInterest?: {
      employees: number;
      employeesWorkedOut: number;
      liabilitiesCents: number;
      shareholderLoansCents: number;
      turnoverCents: number;
      holders: number;
      parts: { employees: number; liabilities: number; turnover: number; holders: number };
      score: number;
      meaning: { audit: boolean; review: null | 'auditor' | 'accounting_officer'; framework: string; summary: string };
    } | null;
  };
  status: StatementStatus;
  row: {
    sentTo: string;
    sentAt: string | null;
    compiler: { name: string; qualification: string; practice: string; date: string; how: 'in_shap' | 'uploaded' } | null;
    compiledOn: string | null;
    compilerReportId: string | null;
    approvedName: string;
    approvedOn: string | null;
  } | null;
  changedSince: boolean;
  audit: { level: 'fail' | 'warn'; section: string; text: string }[];
  /** Agreed with the accountant, or closed: the year's tax goes in through them, not a journal here. */
  yearAgreed?: boolean;
  yearClosed?: boolean;
}

export function FinancialStatements() {
  const isOwner = true;
  const { ref, settings } = useAuthed();
  const years = useApi<Year[]>('/api/statements');
  const [picked, setPicked] = useState<string | null>(null);
  const fyEnd = picked ?? years.data?.[0]?.fyEnd ?? null;
  const view = useApi<StatementsView>(fyEnd ? `/api/statements/${fyEnd}` : null, { fresh: true });
  const [preview, setPreview] = useState(false);
  const [form, setForm] = useState<'details' | 'upload' | 'approve' | 'reopen' | null>(null);
  const reload = async () => {
    setForm(null);
    await Promise.all([years.reload(), view.reload()]);
  };
  const toast = useToast();
  const share = async (path: string, title: string, text?: string) => {
    try {
      if ((await sharePdf(path, title, text)) === 'downloaded') toast('Saved');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t get the file', 'error');
    }
  };
  const v = view.data;
  const s = v?.statements;
  const status = v?.status ?? 'draft';
  // What's for the accountant to look at never stops the signing; the rest must pass.
  const stops = (s?.checks ?? []).filter((c) => c.level !== 'look');
  const looks = (s?.checks ?? []).filter((c) => c.level === 'look');
  const ready = Boolean(s && stops.every((c) => c.ok) && !v?.audit.some((a) => a.level === 'fail'));
  const cc = s?.company?.businessType === 'cc';
  const report = cc ? 'accounting officer’s report' : 'compiler’s report';
  const accountId = (key: string) => (ref.accounts as { id: string; systemKey: string | null }[]).find((a) => a.systemKey === key)?.id;
  const bookTax = async () => {
    if (!s?.taxEstimate) return;
    const debit = accountId('income_tax');
    const credit = accountId('income_tax_payable');
    if (!debit || !credit) return toast('The income tax accounts aren’t in the chart of accounts', 'error');
    if (!confirm(`Book R${(s.taxEstimate.taxCents / 100).toFixed(2)} as the income tax for the year? ${ESTIMATE_SHORT}`)) return;
    try {
      await api('/api/journals', {
        body: {
          date: s.fyEnd,
          description: 'Income tax for the year (Shap’s estimate, to be confirmed by the accountant)',
          lines: [
            { accountId: debit, debitCents: s.taxEstimate.taxCents },
            { accountId: credit, creditCents: s.taxEstimate.taxCents },
          ],
        },
      });
      toast('Booked: the statements show it now');
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t book it', 'error');
    }
  };
  // The small business corporation question (s12E) for the year, answered here for the statements, the tax pack and the IRP6.
  const answerSbc = async (sbc: boolean) => {
    if (!s) return;
    try {
      await api('/api/tax/sbc', { method: 'PUT', body: { fyEnd: s.fyEnd, sbc } });
      toast(sbc ? 'On the small business corporation table' : 'At the company rate');
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save that', 'error');
    }
  };

  if (years.loading && !years.data) return <Loading />;
  if (years.error) return <ErrorBox error={years.error} onRetry={years.reload} />;
  if (!years.data?.length)
    return (
      <div className="panel">
        <Empty title="No year has ended yet">The statements are drawn up once a financial year has ended, from the books of that year.</Empty>
      </div>
    );
  return (
    <div className="stack">
      <p className="small muted">
        Drawn up from the books under the IFRS for SMEs Accounting Standard: the statement of financial position, of comprehensive income, of changes in equity and of cash flows, with the notes, the {s?.governing.many ?? 'directors'}’ report and a detailed income statement.
        {' Share the draft with your accountant; when their signed compiler’s report comes back, upload it here, approve, and the year is finished.'}
      </p>
      <div className="row wrap">
        {years.data.map((y) => (
          <button key={y.fyEnd} type="button" className={`btn small ${y.fyEnd === fyEnd ? 'primary' : ''}`} onClick={() => setPicked(y.fyEnd)}>
            {y.fyEnd.slice(0, 4)}
            <span className="xs">{y.status === 'approved' ? ' · signed' : y.status === 'compiled' ? ' · compiled' : y.status === 'sent' ? ' · sent' : ''}</span>
          </button>
        ))}
      </div>
      <ErrorBox error={view.error} onRetry={view.reload} />
      {view.loading && !v ? (
        <Loading />
      ) : v && s ? (
        <>
          <div className={`banner ${status === 'approved' ? 'ok' : v.changedSince ? 'alert' : 'signal'} stack-sm`}>
            <strong>
              {s.title} {s.period}: {STATEMENT_STATUS_LABELS[status]}
            </strong>
            {status === 'sent' && v.row?.sentAt && (
              <span className="small">
                Sent to {v.row.sentTo} on {formatDate(v.row.sentAt.slice(0, 10))}. When the signed compiler’s report comes back, upload it here.
              </span>
            )}
            {(status === 'compiled' || status === 'approved') && v.row?.compiler && (
              <span className="small">
                Compiled by {v.row.compiler.name}
                {v.row.compiler.qualification ? ` ${v.row.compiler.qualification}` : ''}
                {v.row.compiler.practice ? ` (${v.row.compiler.practice})` : ''} on {formatDate(v.row.compiledOn ?? v.row.compiler.date, 'long')}
                {v.row.compiler.how === 'uploaded' ? ', the signed report uploaded' : ', signed in Shap'}.
              </span>
            )}
            {status === 'approved' && v.row?.approvedOn && (
              <span className="small">
                Approved and signed by {v.row.approvedName} on {formatDate(v.row.approvedOn, 'long')}. The year is agreed and closed.
              </span>
            )}
            {v.changedSince && <span className="small">The books have changed since these were signed, so they no longer agree with them. Reopen them and send them to your accountant again.</span>}
          </div>

          <div className="kpis compact">
            <Kpi label="Revenue" value={<Money cents={s.sci.revenue.reduce((t, l) => t + l.current, 0)} whole />} sub={s.hasPrior ? <>Last year <Money cents={s.sci.revenue.reduce((t, l) => t + l.prior, 0)} whole /></> : undefined} />
            <Kpi label={s.sci.profit.current >= 0 ? 'Profit for the year' : 'Loss for the year'} value={<Money cents={s.sci.profit.current} whole />} tone={s.sci.profit.current < 0 ? 'bad' : undefined} sub={s.hasPrior ? <>Last year <Money cents={s.sci.profit.prior} whole /></> : undefined} />
            <Kpi label="Total assets" value={<Money cents={s.sfp.totalAssets.current} whole />} />
            <Kpi label="Equity" value={<Money cents={s.sfp.equity.current} whole />} tone={s.sfp.equity.current < 0 ? 'warn' : undefined} sub={s.sfp.equity.current < 0 ? 'Liabilities exceed assets: see going concern' : undefined} />
          </div>

          <div className="row wrap">
            <button className="btn" onClick={() => setPreview(true)}>
              <Icon name="statements" size={18} />
              {status === 'approved' ? 'The signed statements' : 'View the draft'}
            </button>
            <button className="btn quiet" onClick={() => void share(`/api/statements/${s.fyEnd}/pdf`, `${s.title} ${s.period}`)}>
              <Icon name="share" size={18} />
              Share or save the PDF
            </button>
            {v.row?.compilerReportId && (
              <button className="btn quiet" onClick={() => void share(`/api/statements/${s.fyEnd}/compiler-report`, 'Compiler’s report')}>
                The signed compiler’s report
              </button>
            )}
            {status !== 'approved' && status !== 'compiled' && (
              <button className="btn quiet" onClick={() => setForm('details')}>
                <Icon name="edit" size={18} />
                Wording and details
              </button>
            )}
          </div>

          <div className="panel panel-pad stack-sm">
            <h3 className="small strong">Checks</h3>
            {stops.map((c) => (
              <div key={c.label} className={`small ${c.ok ? 'ok-text' : 'warn-text'}`}>
                <Icon name={c.ok ? 'check' : 'alert'} size={14} /> {c.label}
                {!c.ok && c.detail && <div className="xs">{c.detail}</div>}
              </div>
            ))}
            {v.audit.filter((a) => a.level === 'fail').length > 0 && (
              <div className="small warn-text">
                <Icon name="alert" size={14} /> The books audit found {v.audit.filter((a) => a.level === 'fail').length} thing{v.audit.filter((a) => a.level === 'fail').length === 1 ? '' : 's'} to fix first:
                <ul className="xs">
                  {v.audit
                    .filter((a) => a.level === 'fail')
                    .slice(0, 6)
                    .map((a, i) => (
                      <li key={i}>
                        {a.section}: {a.text}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {v.audit.some((a) => a.level === 'warn') && (
              <details className="xs muted">
                <summary>
                  {v.audit.filter((a) => a.level === 'warn').length} thing{v.audit.filter((a) => a.level === 'warn').length === 1 ? '' : 's'} to look at (not stopping anything)
                </summary>
                <ul>
                  {v.audit
                    .filter((a) => a.level === 'warn')
                    .map((a, i) => (
                      <li key={i}>
                        {a.section}: {a.text}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </div>

          {looks.length > 0 && (
            <div className="panel panel-pad stack-sm">
              <h3 className="small strong">For your accountant to look at</h3>
              <p className="xs muted">What the standard asks that the books alone can’t settle. None of it stops the signing: your accountant decides, and adjusts with a journal where it matters.</p>
              {looks.map((c) => (
                <div key={c.label} className={`small ${c.ok ? 'ok-text' : 'warn-text'}`}>
                  <Icon name={c.ok ? 'check' : 'alert'} size={14} /> {c.label}
                  {!c.ok && c.detail && <div className="xs">{c.detail}</div>}
                  {!c.ok && c.label.startsWith('The year’s income tax') && s.taxEstimate && (status === 'draft' || status === 'sent') && (
                    <div className="row wrap" style={{ marginTop: 6 }}>
                      {s.taxEstimate.sbc === null ? (
                        <>
                          <button type="button" className="btn small" onClick={() => void answerSbc(true)}>
                            It qualifies: <Money cents={s.taxEstimate.sbcTaxCents ?? 0} />
                          </button>
                          <button type="button" className="btn small" onClick={() => void answerSbc(false)}>
                            It doesn’t: <Money cents={s.taxEstimate.standardTaxCents ?? s.taxEstimate.taxCents} />
                          </button>
                        </>
                      ) : v?.yearAgreed || v?.yearClosed ? (
                        <div className="xs muted">
                          {v.yearClosed ? 'The year is closed' : 'The year is agreed with your accountant at their figures'}, so a journal here wouldn’t change it: the year’s tax goes in through your accountant (Accounts → Year end).
                        </div>
                      ) : (
                        <button type="button" className="btn small" onClick={() => void bookTax()}>
                          Book <Money cents={s.taxEstimate.taxCents} /> as the year’s tax
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {s.publicInterest && (
            <div className="panel panel-pad stack-sm">
              <h3 className="small strong">Public interest score: {s.publicInterest.score}</h3>
              <div className="xs muted">
                {s.publicInterest.parts.employees} for the average employees ({s.publicInterest.employees}) + {s.publicInterest.parts.liabilities} for the liabilities (<Money cents={s.publicInterest.liabilitiesCents} whole />) + {s.publicInterest.parts.turnover} for the turnover (
                <Money cents={s.publicInterest.turnoverCents} whole />) + {s.publicInterest.parts.holders} for the {cc ? 'members' : 'shareholders'} (regulation 26(2)).
              </div>
              <div className="small">{s.publicInterest.meaning.summary}</div>
              <div className="xs muted">Framework: {s.publicInterest.meaning.framework}.</div>
              <p className="xs muted">{ESTIMATE_NOTE} Change the employees or {cc ? 'members' : 'shareholders'} under Wording and details.</p>
            </div>
          )}

          {/* What can be done next, by who's signed in and where the statements are. */}
          <div className="row wrap">
            {isOwner && (status === 'draft' || status === 'sent') && (
              <>
                <button className="btn primary" onClick={() => void share(`/api/statements/${s.fyEnd}/pdf`, `${s.title} ${s.period}`, `Good day,\n\nPlease find our draft financial statements ${s.period} attached, prepared in Shap Pocket. Once you’ve ${cc ? 'done your work as our accounting officer' : 'compiled them'}, please send back your signed ${report}.\n\nKind regards\n${settings.companyName}`)}>
                  <Icon name="share" size={18} />
                  Share with your accountant
                </button>
                <button className="btn" onClick={() => setForm('upload')} disabled={!ready}>
                  <Icon name="upload" size={18} />
                  Upload the signed {report}
                </button>
              </>
            )}
            {isOwner && status === 'compiled' && !v.changedSince && (
              <button className="btn primary" onClick={() => setForm('approve')}>
                <Icon name="check" size={18} />
                Approve and sign: finish the year
              </button>
            )}
            {isOwner && (status === 'compiled' || status === 'approved' || status === 'sent') && (
              <button className="btn quiet" onClick={() => setForm('reopen')}>
                Reopen
              </button>
            )}
          </div>
          {!ready && (status === 'draft' || status === 'sent') && <p className="xs muted">They can be signed once every check passes and the books audit has nothing to fix.</p>}
        </>
      ) : null}

      {preview && s && <PdfPreview title={`${s.title} ${s.period}`} load={async () => (await apiBlob(`/api/statements/${s.fyEnd}/pdf`)).blob} onClose={() => setPreview(false)} />}
      {form === 'details' && s && <DetailsForm defaults={s.policyDefaults} governing={s.governing} onClose={() => setForm(null)} onSaved={reload} />}
      {form === 'upload' && s && <UploadForm fyEnd={s.fyEnd} compiler={s.details.compiler.name} onClose={() => setForm(null)} onDone={reload} />}
      {form === 'approve' && s && <ApproveForm fyEnd={s.fyEnd} governing={s.governing} onClose={() => setForm(null)} onDone={reload} />}
      {form === 'reopen' && s && <ReopenForm fyEnd={s.fyEnd} approved={status === 'approved'} onClose={() => setForm(null)} onDone={reload} />}
    </div>
  );
}

function useSubmit(run: () => Promise<unknown>, onDone: () => Promise<void> | void, done: string) {
  const toast = useToast();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await run();
      toast(done);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

function DetailsForm({ defaults, governing, onClose, onSaved }: { defaults?: Record<PolicyKey, string>; governing: { many: string }; onClose: () => void; onSaved: () => Promise<void> }) {
  const { data, error: loadError, loading } = useApi<StatementDetailsInput>('/api/statements/details', { fresh: true });
  return (
    <Drawer title="Wording and details" sub="On the statements: who governs the business, who compiles it, and the notes" onClose={onClose} wide>
      <ErrorBox error={loadError} />
      {loading || !data ? <Loading /> : <DetailsFields initial={data} defaults={defaults} governing={governing} onSaved={onSaved} />}
    </Drawer>
  );
}

function DetailsFields({ initial, defaults, governing, onSaved }: { initial: StatementDetailsInput; defaults?: Record<PolicyKey, string>; governing: { many: string }; onSaved: () => Promise<void> }) {
  const { settings } = useAuthed();
  const [d, setD] = useState<StatementDetailsInput>(initial);
  const set = <K extends keyof StatementDetailsInput>(k: K, v: StatementDetailsInput[K]) => setD((x) => ({ ...x, [k]: v }));
  const comp = (k: keyof StatementDetailsInput['compiler'], v: string) => setD((x) => ({ ...x, compiler: { ...x.compiler, [k]: v } }));
  const { submit, error, busy } = useSubmit(
    () => api('/api/statements/details', { method: 'PUT', body: { ...d, policies: Object.fromEntries(Object.entries(d.policies).filter(([, v]) => v && v.trim())) } }),
    onSaved,
    'Saved',
  );
  const text = (k: keyof StatementDetailsInput, label: string, hint?: string, rows = 2) => (
    <Field label={label} hint={hint}>
      {(p) => <textarea {...p} className="textarea" rows={rows} value={String(d[k] ?? '')} onChange={(e) => set(k, e.target.value as never)} />}
    </Field>
  );
  return (
    <form className="stack" onSubmit={submit}>
      <Field label="Assurance">
        {(p) => (
          <select {...p} className="select" value={d.assurance} onChange={(e) => set('assurance', e.target.value as Assurance)}>
            {ASSURANCE.map((a) => (
              <option key={a} value={a}>
                {ASSURANCE_LABELS[a]}
              </option>
            ))}
          </select>
        )}
      </Field>
      {settings.businessType === 'company' && (
        <label className="check">
          <input type="checkbox" checked={d.ownerManaged} onChange={(e) => set('ownerManaged', e.target.checked)} />
          <span>
            Every shareholder is also a director
            <div className="xs muted">An owner-managed company is exempt from audit and independent review (Companies Act s30(2A)), so a compilation is enough.</div>
          </span>
        </label>
      )}
      {['company', 'inc', 'npc', 'cc'].includes(settings.businessType) && (
        <fieldset className="fieldset stack-sm">
          <legend className="small strong">For the public interest score</legend>
          <div className="form-grid">
            <Field label={settings.businessType === 'cc' ? 'Members' : 'Shareholders (individuals)'} hint={`Blank: one for each of the ${governing.many} below`}>
              {(p) => <input {...p} className="input" type="number" min={0} value={d.piHolders ?? ''} onChange={(e) => set('piHolders', e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))))} />}
            </Field>
            <Field label="Average employees in the year" hint="Blank: worked out from payroll and the days logged">
              {(p) => <input {...p} className="input" type="number" min={0} step={0.1} value={d.piEmployees ?? ''} onChange={(e) => set('piEmployees', e.target.value === '' ? null : Math.max(0, Number(e.target.value)))} />}
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={d.internallyCompiled} onChange={(e) => set('internallyCompiled', e.target.checked)} />
            <span>
              Compiled by someone in the business, not an independent accountant
              <div className="xs muted">With a score of 100 or more, internally compiled statements must be audited (regulation 28).</div>
            </span>
          </label>
        </fieldset>
      )}
      <fieldset className="fieldset stack-sm">
        <legend className="small strong">{governing.many.charAt(0).toUpperCase() + governing.many.slice(1)}</legend>
        {d.directors.map((x, i) => (
          <div key={i} className="row wrap">
            <input className="input grow" value={x.name} onChange={(e) => set('directors', d.directors.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} placeholder="Full name" aria-label="Name" />
            <input className="input" value={x.role} onChange={(e) => set('directors', d.directors.map((y, j) => (j === i ? { ...y, role: e.target.value } : y)))} placeholder="Role" aria-label="Role" style={{ maxWidth: 160 }} />
            <button type="button" className="btn quiet small" onClick={() => set('directors', d.directors.filter((_, j) => j !== i))} aria-label={`Take ${x.name || 'this one'} off`}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
        <button type="button" className="btn small" onClick={() => set('directors', [...d.directors, { name: '', role: d.directors[0]?.role ?? '' }])}>
          <Icon name="plus" size={16} />
          Add
        </button>
      </fieldset>
      {text('natureOfBusiness', 'Nature of the business', 'Leave blank for Shap’s line from the kind of business')}
      <div className="form-grid">
        {text('registeredAddress', 'Registered address', 'Blank: the business address')}
        {text('postalAddress', 'Postal address (optional)')}
      </div>
      <div className="form-grid">
        <Field label="Bankers">{(p) => <input {...p} className="input" value={d.bankers} onChange={(e) => set('bankers', e.target.value)} placeholder="e.g. a bank’s name" />}</Field>
        <Field label="Secretary (optional)">{(p) => <input {...p} className="input" value={d.secretary} onChange={(e) => set('secretary', e.target.value)} />}</Field>
        <Field label="Holding company (optional)">{(p) => <input {...p} className="input" value={d.holdingCompany} onChange={(e) => set('holdingCompany', e.target.value)} />}</Field>
      </div>
      <fieldset className="fieldset stack-sm">
        <legend className="small strong">{settings.businessType === 'cc' ? 'The accounting officer (and compiler)' : 'The accountant (compiler)'}</legend>
        <div className="form-grid">
          <Field label="Name">{(p) => <input {...p} className="input" value={d.compiler.name} onChange={(e) => comp('name', e.target.value)} />}</Field>
          <Field label="Designation" hint="e.g. CA(SA), AGA(SA), Professional Accountant (SA)">{(p) => <input {...p} className="input" value={d.compiler.qualification} onChange={(e) => comp('qualification', e.target.value)} />}</Field>
          <Field label="Professional body">{(p) => <input {...p} className="input" value={d.compiler.body} onChange={(e) => comp('body', e.target.value)} placeholder="e.g. SAICA, SAIPA" />}</Field>
          <Field label="Practice number">{(p) => <input {...p} className="input" value={d.compiler.number} onChange={(e) => comp('number', e.target.value)} />}</Field>
          <Field label="Practice">{(p) => <input {...p} className="input" value={d.compiler.practice} onChange={(e) => comp('practice', e.target.value)} />}</Field>
  
        </div>
        {text('preparedBy' as keyof StatementDetailsInput, 'Prepared by (optional)', 'Who prepared them, if not the accountant: on the general information page', 1)}
      </fieldset>
      {text('shareCapital', 'Share capital note (optional)', 'e.g. the authorised and issued shares; blank for Shap’s line from the figures')}
      {text('loanTerms', 'Loans from the owners: terms', 'With no fixed terms of repayment they’re current liabilities (IFRS for SMEs 4.7). If the lenders agreed in writing not to call them within twelve months, move the account to non-current (Settings → Chart of accounts) and say so here.')}
      {text('goingConcern', 'Going concern', undefined, 3)}
      {text('eventsAfter', 'Events after the reporting period', undefined, 3)}
      {text('taxNote', 'Tax note (optional)', 'Anything to add to the tax note: assessed losses, a dispute')}
      <details>
        <summary className="small strong">Accounting policies</summary>
        <p className="xs muted">Shap words each one for this business. Change one and yours replaces it; empty it to go back to Shap’s.</p>
        <div className="stack">
          {POLICY_KEYS.map((k) => (
            <Field key={k} label={POLICY_LABELS[k]}>
              {(p) => (
                <textarea
                  {...p}
                  className="textarea"
                  rows={3}
                  value={d.policies[k] ?? ''}
                  placeholder={defaults?.[k] || '(not shown for this business)'}
                  onChange={(e) => set('policies', { ...d.policies, [k]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
      </details>
      {error && <div className="banner alert small">{error}</div>}
      <button className="btn primary big block" disabled={busy}>
        Save
      </button>
    </form>
  );
}

function UploadForm({ fyEnd, compiler, onClose, onDone }: { fyEnd: string; compiler: string; onClose: () => void; onDone: () => Promise<void> }) {
  const cc = useAuthed().settings.businessType === 'cc';
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState(compiler);
  const [date, setDate] = useState(todayIso());
  const [upError, setUpError] = useState('');
  const { submit, error, busy } = useSubmit(() => api(`/api/statements/${fyEnd}/compiler-report`, { body: { attachmentId: file?.id, compilerName: name, date } }), onDone, 'Compiled: ready for you to approve');
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    setUpError('');
    try {
      const r = await api<{ id: string }>('/api/attachments', { body: await compressSlip(f) });
      setFile({ id: r.id, name: f.name });
    } catch (err) {
      setUpError(err instanceof ApiError ? err.message : 'Couldn’t upload it');
    } finally {
      setUploading(false);
    }
  };
  return (
    <Drawer title={cc ? 'The signed accounting officer’s report' : 'The signed compiler’s report'} sub="From your accountant: the report, or the whole signed set" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small muted">Uploading it freezes the statements at their figures as they stand now. Make sure it’s the report for this draft: if the books have changed since you shared it, share it again first.</p>
        <div className="row wrap">
          <label className="btn">
            <Icon name="upload" size={18} />
            {file ? 'Choose another' : 'Choose the PDF or a photo'}
            <input type="file" accept="application/pdf,image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          {uploading && <span className="small muted">Uploading…</span>}
          {file && <span className="small">{file.name}</span>}
        </div>
        {upError && <div className="banner alert small">{upError}</div>}
        <div className="form-grid">
          <Field label="Signed by">{(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
          <Field label="Signed on">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
        </div>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block" disabled={busy || !file}>
          Save: they’re compiled
        </button>
      </form>
    </Drawer>
  );
}

function ApproveForm({ fyEnd, governing, onClose, onDone }: { fyEnd: string; governing: { one: string; signs: string }; onClose: () => void; onDone: () => Promise<void> }) {
  const { user } = useAuthed();
  const [name, setName] = useState(user.name);
  const [date, setDate] = useState(todayIso());
  const [sure, setSure] = useState(false);
  const { submit, error, busy } = useSubmit(() => api(`/api/statements/${fyEnd}/approve`, { body: { name, date } }), onDone, 'Approved: the year is finished');
  return (
    <Drawer title="Approve and sign" sub="The last step of the year" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small">
          Signing as {governing.one}, you approve the statements as compiled. Shap checks the books still give exactly those figures, agrees the year at them and closes it: nothing can be changed in it afterwards. The signed set is kept on file.
        </p>
        <div className="form-grid">
          <Field label="Your name, as signed">{(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
          <Field label="Approved on">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>I approve these financial statements on behalf of the {governing.signs}</span>
        </label>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block" disabled={busy || !sure}>
          Approve and close the year
        </button>
      </form>
    </Drawer>
  );
}

function ReopenForm({ fyEnd, approved, onClose, onDone }: { fyEnd: string; approved: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const { submit, error, busy } = useSubmit(() => api(`/api/statements/${fyEnd}/reopen`, { body: { reason } }), onDone, 'Back to a draft');
  return (
    <Drawer title="Reopen the statements" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small muted">
          They go back to a draft, built from the books as they are, and need compiling and approving again. {approved ? 'The year stays closed until you move its lock date (Accounts → Year end).' : ''} The reason goes in the audit log.
        </p>
        <Field label="Why">{(p) => <input {...p} className="input" value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block" disabled={busy}>
          Reopen
        </button>
      </form>
    </Drawer>
  );
}
