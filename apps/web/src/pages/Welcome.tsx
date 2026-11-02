/**
 * The first time the books are opened: a few questions, one at a time, and the app ends up
 * exactly as big as the business needs. Everything can be changed later in Settings.
 */
import { useState, type ReactNode } from 'react';
import { featuresFor, INDUSTRIES, WORKFLOWS, type IndustryKey, type Workflow } from '@shap/shared';
import { LogoField } from '../components/BusinessForm';
import { Logo } from '../components/Logo';
import { Field, Icon } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { BACKUP_PLACES, phoneBackupTip, placeSteps, restoreFrom, scheduleBackupReminder, setBackupPlace, type BackupPlace } from '../lib/backup';
import { device, isNative, pickFile, platform } from '../lib/native';
import { reportUsage } from '../lib/usage';
import { useAuthed } from '../lib/session';
import type { Settings } from '../lib/types';
import { setTone } from '../lib/words';

const STEPS = ['hello', 'structure', 'industry', 'people', 'workflow', 'logo', 'details', 'backup', 'tone'] as const;
type Step = (typeof STEPS)[number];

export default function WelcomePage({ canRestore = true }: { canRestore?: boolean }) {
  const { settings, refreshReference } = useAuthed();
  const [step, setStep] = useState<Step>('hello');
  const [f, setF] = useState<Settings>({ ...settings });
  const [logoId, setLogoId] = useState(settings.logoId);
  const [industry, setIndustry] = useState<IndustryKey | ''>((settings.industry as IndustryKey) || '');
  const [consent, setConsent] = useState<boolean | null>(null);
  const [employees, setEmployees] = useState<boolean | null>(null);
  const [casual, setCasual] = useState<boolean | null>(null);
  const [dividends, setDividends] = useState<boolean | null>(null);
  const [workflow, setWorkflow] = useState<Workflow>('quote_job_invoice');
  const [place, setPlace] = useState<BackupPlace | null>(null);
  const [remind, setRemind] = useState(true);
  const os = platform();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((x) => ({ ...x, [k]: v }));
  const company = f.businessType === 'company';
  const go = (s: Step) => (setError(''), setStep(s), window.scrollTo(0, 0));
  const next = () => go(STEPS[STEPS.indexOf(step) + 1]!);
  const back = () => go(STEPS[STEPS.indexOf(step) - 1]!);
  const n = STEPS.indexOf(step);

  const finish = async () => {
    setBusy(true);
    setError('');
    const features = { ...f.features, ...featuresFor({ workflow, employees: Boolean(employees), casual: Boolean(casual), company, dividends: dividends ?? false }) };
    try {
      const { logoId: _l, ...rest } = { ...f, features, industry, usageConsent: Boolean(consent), setupDone: true, fyEndMonth: company ? f.fyEndMonth : 2 } as Settings & { logoId: string | null };
      await api('/api/settings', { method: 'PUT', body: rest });
      setTone(f.tone);
      setBackupPlace(place);
      void scheduleBackupReminder(remind);
      if (consent) void reportUsage({ ...f, features, industry, usageConsent: true });
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
            <Choice on={!company} onClick={() => set('businessType', 'sole_prop')} title="Just me, in my own name" hint="A sole proprietor: the profit is taxed as your own income, on SARS’s tables for individuals. Year ends in February." />
            <Choice on={company} onClick={() => set('businessType', 'company')} title="A company (Pty) Ltd" hint="The company pays company tax (small business rates if it qualifies) and can pay you a salary and dividends." />
            <Field label={company ? 'Company name' : 'Business name'} hint={company ? 'e.g. Sparky Electrical (Pty) Ltd' : 'As clients know you, or your own name'}>
              {(p) => <input {...p} className="input" value={f.companyName} onChange={(e) => set('companyName', e.target.value)} />}
            </Field>
            <label className="check">
              <input type="checkbox" checked={f.vatRegistered} onChange={(e) => set('vatRegistered', e.target.checked)} />
              <span>
                Registered for VAT
                <div className="xs muted">Not yet? Shap warns you when you get near the point where you must (R2.3 million a year).</div>
              </span>
            </label>
            {nav(Boolean(f.companyName.trim()))}
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
                  }}
                >
                  {i.label}
                </button>
              ))}
            </div>
            <div className="panel panel-pad stack" style={{ gap: 8 }}>
              <strong className="small">Can Shap let OpenWorks know, anonymously, what kind of business uses it?</strong>
              <span className="xs muted">Only the kind of business and which parts of Shap you switch on, so it can be made better for people like you. Never your name, clients or figures.</span>
              <div className="row">
                <button type="button" className={`btn small ${consent === true ? 'primary' : ''}`} onClick={() => setConsent(true)}>
                  Yes, that’s fine
                </button>
                <button type="button" className={`btn small ${consent === false ? 'primary' : ''}`} onClick={() => setConsent(false)}>
                  No thanks
                </button>
              </div>
            </div>
            {nav(Boolean(industry) && consent !== null)}
          </Q>
        )}

        {step === 'people' && (
          <Q title="Who works with you?" sub="Switch on only what you need.">
            <YesNo q="Do you have employees on a monthly salary?" hint="Payroll: payslips, PAYE, UIF and SDL worked out for you." value={employees} onChange={setEmployees} />
            <YesNo q="Do you use casual labour, paid by the day?" hint="Log the days they work on each job and what you’ve paid them." value={casual} onChange={setCasual} />
            {company && <YesNo q="Will the company pay you dividends?" hint="Declare dividends with the 20% dividends tax handled." value={dividends} onChange={setDividends} />}
            {nav(employees !== null && casual !== null && (!company || dividends !== null))}
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
            <div className="form-grid">
              <Field label="Invoices due after (days)">{(p) => <input {...p} className="input" type="number" min={0} value={f.paymentDays} onChange={(e) => set('paymentDays', Number(e.target.value))} />}</Field>
              {f.vatRegistered && <Field label="VAT number">{(p) => <input {...p} className="input" value={f.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} />}</Field>}
              {company && <Field label="Company registration number">{(p) => <input {...p} className="input" value={f.regNumber} onChange={(e) => set('regNumber', e.target.value)} />}</Field>}
            </div>
            <Field label="Payment terms (on invoices)">{(p) => <textarea {...p} className="textarea" rows={2} value={f.invoiceTerms} onChange={(e) => set('invoiceTerms', e.target.value)} />}</Field>
            {nav()}
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
            {isNative() && (
              <label className="check">
                <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
                <span>
                  Remind me to back up every week
                  <div className="xs muted">A notification a week after your last backup. Back up, and it moves on a week.</div>
                </span>
              </label>
            )}
            {phoneBackupTip(os) && <p className="xs muted">{phoneBackupTip(os)}</p>}
            {nav(true, place ? 'Next' : 'Decide later')}
          </Q>
        )}

        {step === 'tone' && (
          <Q title="How formal are you in business?" sub="Only changes how Shap talks to you. Your quotes and invoices always stay professional.">
            <Choice on={f.tone !== 'formal'} onClick={() => set('tone', 'casual')} title="Not really, keep it lekker" hint="“Howzit!” on Home, “Sharp! Invoice sent”, and a bit of slang." />
            <Choice on={f.tone === 'formal'} onClick={() => set('tone', 'formal')} title="Yes, keep it professional" hint="“Good morning”, “Invoice sent”: plain and polite." />
            {nav(true, busy ? 'Setting up…' : 'Done: open my books', () => void finish())}
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
