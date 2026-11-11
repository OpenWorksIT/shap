/**
 * The first time the books are opened: a few questions, one at a time, and the app ends up
 * exactly as big as the business needs. Everything can be changed later in Settings.
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BUSINESS_TYPES, ENTITIES, entity, extrasFor, featuresFor, INDUSTRIES, paysOutProfit, payoutWord, payeRefProblem, regNumberProblem, sdlRefFor, setupCautions, TERMS_VERSION, TURNOVER_TAX_LIMIT_CENTS, formatZar, uifRefProblem, vatNumberProblem, vatThresholds, WORKFLOWS, type EmployerAnswer, type IndustryKey, type SetupExtras, type Workflow, PAYMENT_DAYS, dayLabel, withPaymentTerm } from '@shap/shared';
import { TermsReview } from '../components/Terms';
import { LogoField } from '../components/BusinessForm';
import { Logo } from '../components/Logo';
import { Field, Icon, MoneyInput } from '../components/ui';
import { TermPicks } from '../components/TermPicks';
import { api, ApiError } from '../lib/api';
import { BACKUP_PLACES, phoneBackupTip, placeSteps, restoreFrom, setBackupPlace, type BackupPlace } from '../lib/backup';
import { device, isNative, pickFile, platform } from '../lib/native';
import { reportUsage } from '../lib/usage';
import { useAuthed } from '../lib/session';
import type { Settings } from '../lib/types';
import { MarketWhat } from '../components/MarketShare';
import { setTone } from '../lib/words';

const STEPS = ['hello', 'structure', 'industry', 'people', 'workflow', 'selling', 'extras', 'logo', 'details', 'backup', 'tone', 'terms'] as const;
type Step = (typeof STEPS)[number];

export default function WelcomePage({ canRestore = true }: { canRestore?: boolean }) {
  const { settings, refreshReference } = useAuthed();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('hello');
  const [f, setF] = useState<Settings>({ ...settings });
  const [logoId, setLogoId] = useState(settings.logoId);
  const [industry, setIndustry] = useState<IndustryKey | ''>((settings.industry as IndustryKey) || '');
  const [consent, setConsent] = useState<boolean | null>(null);
  // On unless switched off; shown here, so the owner has been told (engine modules/market.ts).
  const [market, setMarket] = useState(true);
  const [employees, setEmployees] = useState<boolean | null>(null);
  const [casual, setCasual] = useState<boolean | null>(null);
  const [dividends, setDividends] = useState<boolean | null>(null);
  // With employees: registered with SARS for PAYE, for UIF, and paying SDL?
  const [paye, setPaye] = useState<EmployerAnswer | null>(null);
  const [uif, setUif] = useState<EmployerAnswer | null>(null);
  const [sdl, setSdl] = useState<EmployerAnswer | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [workflow, setWorkflow] = useState<Workflow>('quote_job_invoice');
  const [extras, setExtras] = useState<SetupExtras>(() => extrasFor(settings.industry || ''));
  const [movingIn, setMovingIn] = useState<boolean | null>(null);
  const extra = (k: keyof SetupExtras) => (v: boolean) => setExtras((x) => ({ ...x, [k]: v }));
  // Sells over the counter? (Stock records are full Shap's.) And does Shap Pocket draft the annual statements?
  const [sales, setSales] = useState<boolean | null>(settings.features.sales ? true : null);
  const [statements, setStatements] = useState<boolean | null>(settings.features.statements ? true : null);
  // Selling: how each month is closed (month end): by hand, or it locks itself on a day of the next month.
  // A VAT vendor that doesn't sell: each VAT period instead, the same way.
  const [monthEnd, setMonthEnd] = useState<'manual' | 'auto' | null>(settings.features.sales || settings.vatRegistered ? settings.monthEndMode ?? null : null);
  const [monthEndDay, setMonthEndDay] = useState(settings.monthEndDay ?? 7);
  const [place, setPlace] = useState<BackupPlace | null>(null);
  const os = platform();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((x) => ({ ...x, [k]: v }));
  const kind = entity(f.businessType);
  // Pays its owners out of profit (dividends, or a CC's or trust's distributions).
  const paysOut = paysOutProfit(f.businessType);
  // A company (Inc., CC, co-op) declares its dividends to SARS: the section is always on for it.
  const dividendsAlways = kind.dividendsTax;
  const vatProblem = f.vatRegistered ? (f.vatNumber.trim() ? vatNumberProblem(f.vatNumber) : 'Add your VAT number') : null;
  const regProblem = regNumberProblem(f.regNumber, f.businessType);
  const payeProblem = paye === 'yes' ? (f.payeRef.trim() ? payeRefProblem(f.payeRef) : 'Add your PAYE reference') : null;
  const uifProblem = uif === 'yes' ? uifRefProblem(f.uifRef) : null;
  const compulsory = formatZar(vatThresholds(new Date().toISOString().slice(0, 10)).compulsoryCents, { cents: false });
  const common = f.businessType === 'sole_prop' || f.businessType === 'company';
  const go = (s: Step) => (setError(''), setStep(s), window.scrollTo(0, 0));
  const next = () => go(STEPS[STEPS.indexOf(step) + 1]!);
  const back = () => go(STEPS[STEPS.indexOf(step) - 1]!);
  const n = STEPS.indexOf(step);

  const finish = async () => {
    setBusy(true);
    setError('');
    const features = {
      ...f.features,
      ...featuresFor({ workflow, employees: Boolean(employees), casual: Boolean(casual), company: paysOut, dividends: dividendsAlways || (dividends ?? false), extras, payshap: Boolean(f.payshapId.trim()), selling: { sales: Boolean(sales), inventory: false }, statements: Boolean(statements) }),
    };
    try {
      const employer = employees
        ? { payeRegistered: paye === 'yes', payeRef: paye === 'yes' ? f.payeRef : '', uifRegistered: uif === 'yes', uifRef: uif === 'yes' ? f.uifRef : '', sdl: sdl === 'yes' }
        : { payeRegistered: null, payeRef: '', uifRegistered: null, uifRef: '', sdl: false };
      const { logoId: _l, termsAcceptedAt: _t, ...rest } = { ...f, ...employer, features, industry, usageConsent: Boolean(consent), marketConsent: market, marketNoticeSeen: true, setupDone: true, termsVersion: TERMS_VERSION, fyEndMonth: kind.febYearEnd ? 2 : f.fyEndMonth, turnoverTax: kind.turnoverTax && f.turnoverTax } as Settings & { logoId: string | null };
      await api('/api/settings', { method: 'PUT', body: rest });
      if ((sales || f.vatRegistered) && monthEnd) await api('/api/periods/month-end', { method: 'PUT', body: { mode: monthEnd, day: monthEndDay } });
      setTone(f.tone);
      setBackupPlace(place);
      if (consent) void reportUsage({ ...f, features, industry, usageConsent: true });
      // Moving from another package: straight to the screen that brings the books across.
      if (movingIn) navigate('/move-in', { replace: true });
      await refreshReference();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
      setBusy(false);
    }
  };

  const restore = async () => {
    const file = await pickFile([]);
    if (!file) return;
    setBusy(true);
    try {
      await restoreFrom(file);
      window.location.reload();
    } catch (err) {
      setError(`That file couldn’t be restored: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  const nav = (ok = true, label = 'Next', onNext = next) => (
    <>
      {error && <div className="banner alert small">{error}</div>}
      <div className="row">
        <button type="button" className="btn quiet" onClick={back}>
          Back
        </button>
        <button type="button" className="btn primary big grow" disabled={!ok || busy} onClick={onNext}>
          {label}
        </button>
      </div>
    </>
  );

  return (
    <div className="welcome">
      <div className="welcome-card stack-lg">
        {n > 0 && (
          <div className="steps" aria-label={`Step ${n} of ${STEPS.length - 1}`}>
            {STEPS.slice(1).map((s, i) => (
              <span key={s} className={i < n ? 'on' : ''} />
            ))}
          </div>
        )}

        {step === 'hello' && (
          <>
            <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
              <Logo size={72} />
              <h1>Welcome to Shap</h1>
              <p className="muted">Quotes, invoices, costs and tax for your business. A few quick questions and Shap sets itself up to fit: no bigger than you need.</p>
              <p className="small welcome-gift">
                A gift from OpenWorks IT to South African business: free, open and never any ads{isNative() ? '' : ', kept going by people who chip in'}. Less admin, more building.
              </p>
            </div>
            <button className="btn primary big block" onClick={next}>
              Let’s set up
            </button>
            {canRestore && (
              <button className="btn quiet block" onClick={() => void restore()} disabled={busy}>
                I have a backup to restore
              </button>
            )}
            {error && <div className="banner alert small">{error}</div>}
          </>
        )}

        {step === 'structure' && (
          <Q title="How is your business set up?" sub="This decides how your tax is worked out.">
            <Choice on={f.businessType === 'sole_prop'} onClick={() => set('businessType', 'sole_prop')} title="Just me, in my own name" hint="A sole proprietor: the profit is taxed as your own income, on SARS’s tables for individuals. Year ends in February." />
            <Choice on={f.businessType === 'company'} onClick={() => set('businessType', 'company')} title="A company (Pty) Ltd" hint="The company pays company tax (small business rates if it qualifies) and can pay you a salary and dividends." />
            <Choice on={!common} onClick={() => common && set('businessType', 'partnership')} title="A partnership, CC, trust or something else" hint="Partnerships, close corporations, trading trusts, Inc. companies, non-profit companies and co-operatives." />
            {!common && (
              <Field label="Which kind?" hint={`${kind.description} ${kind.ownerMoney}`}>
                {(p) => (
                  <select {...p} className="select" value={f.businessType} onChange={(e) => set('businessType', e.target.value as Settings['businessType'])}>
                    {BUSINESS_TYPES.filter((t) => t !== 'sole_prop' && t !== 'company').map((t) => (
                      <option key={t} value={t}>
                        {ENTITIES[t].label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            {f.businessType === 'partnership' && <p className="xs muted">You’ll add the partners and their shares of the profit in Settings, after these questions.</p>}
            <Field label={f.businessType === 'sole_prop' || f.businessType === 'partnership' ? 'Business name' : 'Registered name'} hint={kind.example}>
              {(p) => <input {...p} className="input" value={f.companyName} onChange={(e) => set('companyName', e.target.value)} />}
            </Field>
            <label className="check">
              <input type="checkbox" checked={f.vatRegistered} onChange={(e) => set('vatRegistered', e.target.checked)} />
              <span>
                Registered for VAT
                <div className="xs muted">Not yet? Shap watches your income over any 12 months in a row and warns you as it nears {compulsory}, the point where registering is compulsory.</div>
              </span>
            </label>
            {f.vatRegistered && (
              <div className="form-grid">
                <Field label="VAT number" hint="10 digits starting with 4, on your VAT registration letter" error={f.vatNumber.trim() ? (vatProblem ?? undefined) : undefined}>
                  {(p) => <input {...p} className="input" inputMode="numeric" value={f.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} placeholder="4123456789" />}
                </Field>
                <Field label="You file VAT" hint="On your VAT registration letter">
                  {(p) => (
                    <select {...p} className="select" value={f.vatCategory} onChange={(e) => set('vatCategory', e.target.value as Settings['vatCategory'])}>
                      <option value="B">Every two months (Feb, Apr, Jun…)</option>
                      <option value="A">Every two months (Jan, Mar, May…)</option>
                      <option value="C">Every month</option>
                    </select>
                  )}
                </Field>
              </div>
            )}
            {kind.turnoverTax && <label className="check">
              <input type="checkbox" checked={f.turnoverTax} onChange={(e) => set('turnoverTax', e.target.checked)} />
              <span>
                Registered for turnover tax
                <div className="xs muted">SARS’s simpler tax for micro businesses (turnover up to {formatZar(TURNOVER_TAX_LIMIT_CENTS, { cents: false })} a year). Only if you registered for it: not sure? Leave it off.</div>
              </span>
            </label>}
            {f.vatRegistered && vatProblem && <p className="xs muted">To charge VAT, Shap needs your VAT number: it goes on every tax invoice. Not registered yet? Untick “Registered for VAT” for now.</p>}
            {nav(Boolean(f.companyName.trim()) && !vatProblem)}
          </Q>
        )}

        {step === 'industry' && (
          <Q title="What do you do?" sub="So Shap starts with what a business like yours uses.">
            <div className="choice-grid">
              {INDUSTRIES.map((i) => (
                <button
                  key={i.key}
                  type="button"
                  className={`choice small ${industry === i.key ? 'on' : ''}`}
                  onClick={() => {
                    setIndustry(i.key);
                    setWorkflow(i.workflow);
                    setExtras(extrasFor(i.key));
                  }}
                >
                  {i.label}
                </button>
              ))}
            </div>
            <div className="panel panel-pad stack" style={{ gap: 8 }}>
              <strong className="small">Can Shap let OpenWorks know, anonymously, what kind of business uses it?</strong>
              <span className="xs muted">Only the kind of business and which parts of Shap you switch on, sent after an update and about once a month, so it can be made better for people like you. Never your name, clients or figures.</span>
              <div className="row">
                <button type="button" className={`btn small ${consent === true ? 'primary' : ''}`} onClick={() => setConsent(true)}>
                  Yes, that’s fine
                </button>
                <button type="button" className={`btn small ${consent === false ? 'primary' : ''}`} onClick={() => setConsent(false)}>
                  No thanks
                </button>
              </div>
            </div>
            <label className="check panel panel-pad">
              <input type="checkbox" checked={market} onChange={(e) => setMarket(e.target.checked)} />
              <span>
                <strong className="small">Share anonymous prices, to help show what work typically costs</strong>
                <div>
                  <MarketWhat />
                </div>
              </span>
            </label>
            {nav(Boolean(industry) && consent !== null)}
          </Q>
        )}

        {step === 'people' && (
          <Q title="Who works with you?" sub="Switch on only what you need.">
            <YesNo q="Do you have employees on a monthly salary?" hint="Payroll: payslips, PAYE, UIF and SDL worked out for you." value={employees} onChange={setEmployees} />
            {employees && (
              <div className="panel panel-pad stack" style={{ gap: 12 }}>
                <strong className="small">As an employer, are you registered for…</strong>
                <Answer q="PAYE (employees’ tax), with SARS" value={paye} onChange={setPaye} />
                {paye === 'yes' && (
                  <Field label="PAYE reference" hint="10 digits starting with 7, on your EMP201" error={f.payeRef.trim() ? (payeProblem ?? undefined) : undefined}>
                    {(p) => <input {...p} className="input" inputMode="numeric" value={f.payeRef} onChange={(e) => set('payeRef', e.target.value)} placeholder="7123456789" />}
                  </Field>
                )}
                {paye && paye !== 'yes' && (
                  <p className="xs banner">
                    An employer must register for PAYE within 21 business days of becoming one, unless no employee earns enough to pay tax. Shap works out the PAYE on each payslip; registering, declaring (EMP201) and paying SARS stay with you.
                  </p>
                )}
                <Answer q="UIF (Unemployment Insurance Fund)" value={uif} onChange={setUif} />
                {uif === 'yes' && (
                  <Field label="UIF reference (optional)" hint="From the Department of Employment and Labour (1234567/8), or SARS’s U-number" error={uifProblem ?? undefined}>
                    {(p) => <input {...p} className="input" value={f.uifRef} onChange={(e) => set('uifRef', e.target.value)} placeholder="1234567/8" />}
                  </Field>
                )}
                {uif && uif !== 'yes' && (
                  <p className="xs banner">
                    UIF covers anyone working 24 hours a month or more for you: 1% from them and 1% from you. Employers registered for PAYE register for UIF with SARS; others with the UI Commissioner. Shap works it out; registering and paying are yours to do.
                  </p>
                )}
                <Answer q="SDL (Skills Development Levy)" value={sdl} onChange={setSdl} unsure={false} />
                {sdl === 'yes' && paye === 'yes' && !payeProblem && <p className="xs muted">Your SDL reference is {sdlRefFor(f.payeRef)}: your PAYE reference with an L in front.</p>}
                {sdl === 'no' && <p className="xs muted">That’s right while your total payroll is expected to stay under R500 000 over the next 12 months. Once it isn’t, register and switch SDL on in Settings.</p>}
              </div>
            )}
            <YesNo q="Do you use casual labour, paid by the day?" hint="Log the days they work on each job and what you’ve paid them. Shap keeps the record; UIF, tax and the minimum wage for them are yours to handle (someone working 24 hours a month or more is your employee in the law): Workers says more." value={casual} onChange={setCasual} />
            {paysOut && dividendsAlways && (
              <p className="xs muted panel panel-pad">
                {kind.the.charAt(0).toUpperCase() + kind.the.slice(1)} declares every {payoutWord(f.businessType)} it pays to SARS (the DTR01 and DTR02, by the end of the next month), so the {payoutWord(f.businessType)}s section is on, ready for when you pay one.
              </p>
            )}
            {paysOut && !dividendsAlways && (
              <YesNo
                q={`Will ${kind.the} pay ${kind.owner.many} ${payoutWord(f.businessType)}s?`}
                hint={kind.dividendsTax ? 'Record them with the 20% dividends tax handled.' : 'Record them: the tax estimate takes this year’s income given to South African beneficiaries off the trust’s taxable income.'}
                value={dividends}
                onChange={setDividends}
              />
            )}
            {nav(employees !== null && casual !== null && (!paysOut || dividendsAlways || dividends !== null) && (!employees || (paye !== null && uif !== null && sdl !== null && !payeProblem && !uifProblem)))}
          </Q>
        )}

        {step === 'workflow' && (
          <Q title="How does your work run?" sub="A hairdresser might just invoice; a builder quotes, runs the job, then invoices.">
            {WORKFLOWS.map((w) => (
              <Choice key={w.key} on={workflow === w.key} onClick={() => setWorkflow(w.key)} title={w.label} hint={w.hint} />
            ))}
            {nav()}
          </Q>
        )}

        {step === 'selling' && (
          <Q title="Do you sell things over the counter?" sub="Walk-in customers who pay on the spot: a stall, a shop, a salon’s products, parts at the counter.">
            <YesNo
              q="Do you do sales?"
              hint="A Sales tab: pick what’s sold from a quick list, take the money, and hand over the invoice (each sale is an invoice, numbered with your others). A big customer’s details can go on it at the time or afterwards, and refunds are a tap."
              value={sales}
              onChange={setSales}
            />
            {sales && <p className="xs muted">Shap Pocket sells without keeping stock records: keep your stock list where you have it. Full Shap, on a computer, has the inventory (stock on hand, supplier invoices, stock takes).</p>}
            {sales && (
              <div className="stack-sm">
                <p className="strong">Month end: how should each month be closed?</p>
                <p className="small muted">Once a month is closed, nothing dated in it can change, so the takings, the VAT and the bank stay as they were checked. You can reopen it, with the reason, to put something right.</p>
                <Choice on={monthEnd === 'manual'} onClick={() => setMonthEnd('manual')} title="I’ll close each month myself" hint="Accounts → Locks shows the month’s figures and a button to close it. Home reminds you while last month is still open." />
                <Choice on={monthEnd === 'auto'} onClick={() => setMonthEnd('auto')} title="Close it by itself" hint="Each month locks itself on a day of the next month, whether or not it’s been checked. You can still close one earlier." />
                {monthEnd && (
                  <Field label={monthEnd === 'auto' ? 'Day of the next month it locks' : 'Day of the next month to remind me'} hint="1 to 28">
                    {(p) => <input {...p} className="input" type="number" min={1} max={28} value={monthEndDay} onChange={(e) => setMonthEndDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 100 }} />}
                  </Field>
                )}
              </div>
            )}
            {sales === false && f.vatRegistered && (
              <div className="stack-sm">
                <p className="strong">VAT period end: how should each VAT period be closed?</p>
                <p className="small muted">Once a VAT period is closed, nothing dated in it can change, so what the VAT201 was worked out from stays as it was checked. You can reopen it, with the reason, to put something right.</p>
                <Choice on={monthEnd === 'manual'} onClick={() => setMonthEnd('manual')} title="I’ll close each VAT period myself" hint="Accounts → Locks shows the period’s figures and a button to close it. Home reminds you while the last one is still open." />
                <Choice on={monthEnd === 'auto'} onClick={() => setMonthEnd('auto')} title="Close it by itself" hint="Each VAT period locks itself on a day of the month after it ends, whether or not it’s been checked. You can still close one earlier." />
                {monthEnd && (
                  <Field label={monthEnd === 'auto' ? 'Day of the month after the period that it locks' : 'Day of the month after the period to remind me'} hint="1 to 28: before the VAT201 is due (the last business day of that month on eFiling)">
                    {(p) => <input {...p} className="input" type="number" min={1} max={28} value={monthEndDay} onChange={(e) => setMonthEndDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 100 }} />}
                  </Field>
                )}
              </div>
            )}
            {nav((sales === false && (!f.vatRegistered || monthEnd !== null)) || (sales === true && monthEnd !== null))}
          </Q>
        )}

        {step === 'extras' && (
          <Q title="What else would help?" sub="Shap has guessed from what you do. Change anything that doesn’t fit: it can all be switched on or off later under Settings → What you use.">
            <YesNo q="Do you charge for your time by the hour?" hint="A clock to start and stop on each job, your hourly rate, and the hours onto the invoice in one tap." value={extras.hourly} onChange={extra('hourly')} />
            {extras.hourly && (
              <Field label="Your usual hourly rate" hint="Each job can have its own rate too">
                {(p) => <MoneyInput {...p} value={f.hourlyRateCents || null} onChange={(c) => set('hourlyRateCents', c ?? 0)} placeholder="e.g. 450" />}
              </Field>
            )}
            <YesNo q="Do you drive for work?" hint="SARS’s travel logbook: each business trip and the odometer at the start and end of the tax year. You need it to claim your travel." value={extras.travel} onChange={extra('travel')} />
            <YesNo q="Do suppliers give you bills to pay later (an account)?" hint="Bills to pay: what you owe, when it’s due, and a nudge on Home before it is." value={extras.bills} onChange={extra('bills')} />
            <YesNo q="Do clients sometimes pay before you start?" hint="Pro-forma invoices: ask for the money up front, without a tax invoice. Once paid, turn it into the invoice." value={extras.upfront} onChange={extra('upfront')} />
            <YesNo
              q="Should Shap Pocket draw up your annual financial statements?"
              hint="Yes: they’re prepared from your books (IFRS for SMEs), you send them to your accountant, and once their signed compiler’s report is back here the year is finished. No: your accountant prepares them in their own software from what Shap Pocket gives them."
              value={statements}
              onChange={setStatements}
            />
            <YesNo q="Are you moving from another package?" hint="Sage, Xero, QuickBooks, Zoho or Invoice Ninja: after setup Shap opens Move in, to bring your clients, invoices and balances across." value={movingIn} onChange={setMovingIn} />
            <p className="xs muted">Switched on for everyone: credit notes, payment reminders on Home (with a message ready for WhatsApp) and step-by-step SARS filing guides.</p>
            {nav(movingIn !== null && statements !== null)}
          </Q>
        )}

        {step === 'logo' && (
          <Q title="Your logo" sub="Optional. Add it from your photos or files, then drag and size it until it sits right.">
            <LogoField logoId={logoId} layout={f.logoLayout ?? {}} accent={f.accent ?? '#e8731c'} onLogo={setLogoId} onLayout={(l) => set('logoLayout', l)} />
            {nav(true, logoId ? 'Next' : 'Skip for now')}
          </Q>
        )}

        {step === 'details' && (
          <Q title="On your invoices" sub="Fill in what you have; the rest can wait.">
            <div className="form-grid">
              <Field label="Phone">{(p) => <input {...p} className="input" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />}</Field>
              <Field label="Email">{(p) => <input {...p} className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}</Field>
            </div>
            <Field label="Address">{(p) => <textarea {...p} className="textarea" rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} />}</Field>
            <Field label="Bank details" hint="Printed on invoices so clients can pay you">
              {(p) => <textarea {...p} className="textarea" rows={3} value={f.bankDetails} onChange={(e) => set('bankDetails', e.target.value)} placeholder={'Capitec · Savings\nAccount 1234567890 · Branch 470010'} />}
            </Field>
            <Field label="Card payment link (optional)" hint="Use Yoco? Paste your payment link: clients can pay invoices by card.">
              {(p) => <input {...p} className="input" type="url" inputMode="url" value={f.payLink} onChange={(e) => set('payLink', e.target.value)} placeholder="https://pay.yoco.com/…" />}
            </Field>
            <Field label="Your ShapID for PayShap (optional)" hint="Your cellphone number or the ShapID from your bank. Printed on invoices so clients can pay you instantly from their banking app.">
              {(p) => <input {...p} className="input" value={f.payshapId} onChange={(e) => set('payshapId', e.target.value)} placeholder="e.g. 082 123 4567" />}
            </Field>
            <div className="form-grid">
              <Field label="Invoices due after (days)">
                {(p) => (
                  <>
                    <input {...p} className="input" type="number" min={0} value={f.paymentDays} onChange={(e) => set('paymentDays', Number(e.target.value))} />
                    <TermPicks
                      label="Invoices due after"
                      options={PAYMENT_DAYS.map((n) => ({ value: n as number, label: dayLabel(n) }))}
                      value={f.paymentDays}
                      onPick={(n) => (set('paymentDays', n), set('invoiceTerms', withPaymentTerm(f.invoiceTerms, n)))}
                    />
                  </>
                )}
              </Field>
              {kind.regLabel && (
                <Field label={kind.regLabel} hint={kind.regHint} error={regProblem ?? undefined}>
                  {(p) => <input {...p} className="input" value={f.regNumber} onChange={(e) => set('regNumber', e.target.value)} placeholder={kind.regPlaceholder} />}
                </Field>
              )}
            </div>
            <Field label="Payment terms (on invoices)">{(p) => <textarea {...p} className="textarea" rows={2} value={f.invoiceTerms} onChange={(e) => set('invoiceTerms', e.target.value)} />}</Field>
            {nav(!regProblem)}
          </Q>
        )}

        {step === 'backup' && (
          <Q title={`Keep a copy off your ${device()}`} sub={`Everything in Shap Pocket lives on this ${device()}, not on the internet. If the ${device()} is stolen, broken or lost${isNative() ? '' : ', or the browser’s data is cleared'}, your books go with it, unless there’s a backup.`}>
            <p className="small">Where would you keep your backups?</p>
            <div className="choice-grid">
              {BACKUP_PLACES.filter((p) => !(p.android === false && os !== 'ios')).map((p) => (
                <button key={p.key} type="button" className={`choice small ${place === p.key ? 'on' : ''}`} onClick={() => setPlace(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
            {place && (
              <div className="panel panel-pad stack" style={{ gap: 8 }}>
                <strong className="small">How it works</strong>
                <ol className="small steps-list">
                  {placeSteps(place, os).map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
                <span className="xs muted">Your first backup is worth making once you’ve added some work. Back up any time from the menu: Backup.</span>
              </div>
            )}
            <p className="xs muted">Backups are yours to make: Shap Pocket and OpenWorks never see or keep your books, so nobody else can restore them. Home reminds you when one is due.</p>
            {phoneBackupTip(os) && <p className="xs muted">{phoneBackupTip(os)}</p>}
            {nav(true, place ? 'Next' : 'Decide later')}
          </Q>
        )}

        {step === 'tone' && (
          <Q title="How formal are you in business?" sub="Only changes how Shap talks to you. Your quotes and invoices always stay professional.">
            <Choice on={f.tone !== 'formal'} onClick={() => set('tone', 'casual')} title="Not really, keep it lekker" hint="“Howzit!” on Home, “Sharp! Invoice sent”, and a bit of slang." />
            <Choice on={f.tone === 'formal'} onClick={() => set('tone', 'formal')} title="Yes, keep it professional" hint="“Good morning”, “Invoice sent”: plain and polite." />
            {nav()}
          </Q>
        )}

        {step === 'terms' && (
          <Q title="Last step: the terms of use" sub="Shap is free, and it’s yours to run. These are the few things that come with that.">
            <TermsReview
              cautions={setupCautions({ vatRegistered: f.vatRegistered, employees: Boolean(employees), payeRegistered: paye, uifRegistered: uif, sdl, turnoverTax: kind.turnoverTax && f.turnoverTax, paysDividends: dividendsAlways || Boolean(dividends) })}
              accepted={accepted}
              onAccepted={setAccepted}
            />
            {nav(accepted, busy ? 'Setting up…' : 'Accept and open my books', () => void finish())}
          </Q>
        )}
      </div>
    </div>
  );
}

function Q({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="stack-lg">
      <div>
        <h2>{title}</h2>
        {sub && <p className="small muted">{sub}</p>}
      </div>
      <div className="stack">{children}</div>
    </div>
  );
}

function Choice({ on, onClick, title, hint }: { on: boolean; onClick: () => void; title: string; hint?: string }) {
  return (
    <button type="button" className={`choice ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on}>
      <strong>
        {on && <Icon name="check" size={16} />} {title}
      </strong>
      {hint && <span className="xs muted">{hint}</span>}
    </button>
  );
}

function Answer({ q, value, onChange, unsure = true }: { q: string; value: EmployerAnswer | null; onChange: (v: EmployerAnswer) => void; unsure?: boolean }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="small">{q}</span>
      <div className="row wrap">
        {(['yes', 'no', ...(unsure ? ['unsure' as const] : [])] as EmployerAnswer[]).map((v) => (
          <button key={v} type="button" className={`btn small ${value === v ? 'primary' : ''}`} onClick={() => onChange(v)}>
            {v === 'yes' ? 'Yes' : v === 'no' ? 'No' : 'Not sure'}
          </button>
        ))}
      </div>
    </div>
  );
}

function YesNo({ q, hint, value, onChange }: { q: string; hint?: string; value: boolean | null; onChange: (v: boolean) => void }) {
  return (
    <div className="panel panel-pad stack" style={{ gap: 8 }}>
      <strong className="small">{q}</strong>
      {hint && <span className="xs muted">{hint}</span>}
      <div className="row">
        <button type="button" className={`btn small ${value === true ? 'primary' : ''}`} onClick={() => onChange(true)}>
          Yes
        </button>
        <button type="button" className={`btn small ${value === false ? 'primary' : ''}`} onClick={() => onChange(false)}>
          No
        </button>
      </div>
    </div>
  );
}
