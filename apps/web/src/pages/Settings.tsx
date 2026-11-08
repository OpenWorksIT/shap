import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPES, CATEGORY_KIND_LABELS, CATEGORY_KINDS, BUSINESS_TYPES, ENTITIES, entity, formatDate, paysOutProfit, payeRefProblem, payoutWord, uifRefProblem, formatZar, monthLabel, passwordProblem, ROLE_HINTS, ROLE_LABELS, SHAP_LINE, ROLES, SOURCE_KIND_LABELS, SOURCE_KINDS, type AccountType, type CategoryKind, type Role, type SourceKind } from '@shap/shared';
import { PageHead } from '../components/Shell';
import { Drawer, ErrorBox, Field, Icon, Loading, MoneyInput, Tabs, useToast } from '../components/ui';
import { api, ApiError, APP_VERSION } from '../lib/api';
import { cleanPngLogo, shrinkImage } from '../lib/files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { Brand, Settings } from '../lib/types';
import { BusinessFields, LogoField } from '../components/BusinessForm';
import { Partners } from '../components/Partners';
import { ApiImage } from '../components/Files';
import { FEATURES, FEATURE_GROUPS, FEATURE_KEYS, featureOn, INDUSTRIES, TERMS_URL, TURNOVER_TAX_LIMIT_CENTS } from '@shap/shared';
import { WipeData } from '../components/WipeData';
import { device, isNative } from '../lib/native';
import { reportUsage } from '../lib/usage';
import { setTone, type Tone } from '../lib/words';
import { SupportShap } from '../components/Support';
import { MarketWhat } from '../components/MarketShare';
import { AuditLog } from '../components/AuditLog';

type Tab = 'business' | 'invoicing' | 'sections' | 'lists' | 'audit';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'business';
  const { has } = useAuthed();
  return (
    <div className="stack-lg">
      <PageHead title="Settings" />
      <div className="tabs-scroll">
        <Tabs<Tab>
          value={tab}
          onChange={(t) => setParams({ tab: t }, { replace: true })}
          tabs={[
            { value: 'business', label: 'Your business' },
            { value: 'invoicing', label: 'Invoicing & tax' },
            { value: 'sections', label: 'What you use' },
            { value: 'lists', label: 'Lists' },
            { value: 'audit', label: 'Audit log' },
          ]}
        />
      </div>
      {tab === 'business' && (
        <>
          <BusinessSettings />
          <Partners />
          {has('brands') && <TradingNames />}
          <section className="panel panel-pad stack narrow-wide">
            <h3>Coming from another package?</h3>
            <p className="small">Bring your clients, invoices (with what’s been paid), quotes, items and opening balances from Sage, Xero, QuickBooks, Zoho or Invoice Ninja.</p>
            <Link className="btn" to="/move-in" style={{ alignSelf: 'flex-start' }}>
              <Icon name="upload" size={18} />
              Move in
            </Link>
          </section>
          <WipeData />
        </>
      )}
      {tab === 'invoicing' && <SettingsForm section="invoicing" />}
      {tab === 'sections' && <Sections />}
      {tab === 'lists' && <Lists />}
      {tab === 'audit' && <AuditLog />}
      <About />
    </div>
  );
}

function About() {
  const { settings } = useAuthed();
  return (
    <section className="panel panel-pad stack narrow-wide">
      <h3>About Shap Pocket</h3>
      <p className="small">
        Version {APP_VERSION}. Free and open source (AGPL-3.0 with an app store exception), by OpenWorks IT. Your books stay on this {device()}: there’s no Shap server.
      </p>
      <p className="small">
        Source code: <a href="https://github.com/OpenWorksIT/shap-pocket" target="_blank" rel="noreferrer">github.com/OpenWorksIT/shap-pocket</a>
      </p>
      <p className="xs muted">
        Keep Shap Pocket up to date ({isNative() ? 'from the Play Store or App Store' : 'by reopening this page when it says there’s a new version'}): updates carry security fixes and each year’s changes to tax tables, VAT, payroll
        and accounting rules, and need an internet connection. Updating, and keeping backups somewhere other than this {device()}, are your responsibility: OpenWorks never has a copy of your books
        and can’t recover them.
      </p>
      <p className="xs muted">
        Shap Pocket is a record-keeping tool, not an accountant, and its tax figures aren’t tax advice: use it to capture and collate your records for your accountant, and check figures before you
        file. <a href={TERMS_URL} target="_blank" rel="noreferrer">Terms of use</a> (accepted {settings.termsAcceptedAt ? formatDate(settings.termsAcceptedAt.slice(0, 10)) : 'in setup'}).
      </p>
    </section>
  );
}

/** Saves settings: everything as it is, with these changes. */
async function saveSettings(settings: Settings, changes: Partial<Settings>) {
  const { logoId: _l, ...rest } = { ...settings, ...changes } as Settings & { logoId: string | null };
  await api('/api/settings', { method: 'PUT', body: rest });
}

function BusinessSettings() {
  const { settings, refreshReference, has } = useAuthed();
  const toast = useToast();
  const [f, setF] = useState<Settings>({ ...settings });
  const [logoId, setLogoId] = useState(settings.logoId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { features: _f, tone: _t, industry: _i, usageConsent: _u, sdl: _s, watermark: _w, ...mine } = f;
      // The same rules the engine applies on saving (entities.ts).
      const k = entity(f.businessType);
      await saveSettings(settings, { ...mine, fyEndMonth: k.febYearEnd ? 2 : f.fyEndMonth, turnoverTax: k.turnoverTax && f.turnoverTax, approvedPbo: k.key === 'npc' && f.approvedPbo });
      await refreshReference();
      toast('Saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack-lg narrow-wide" onSubmit={save}>
      <section className="panel panel-pad stack">
        <h3>Your business</h3>
        <BusinessFields f={f} set={set as never} />
        {has('payroll') && (
          <div className="stack" style={{ gap: 8 }}>
            <strong className="small">As an employer</strong>
            <div className="form-grid">
              <label className="check">
                <input type="checkbox" checked={Boolean(f.payeRegistered)} onChange={(e) => set('payeRegistered', e.target.checked)} />
                <span>Registered for PAYE with SARS</span>
              </label>
              {f.payeRegistered && (
                <Field label="PAYE reference" hint="10 digits starting with 7 (SDL and SARS’s UIF number are the same digits with L and U)" error={f.payeRef !== settings.payeRef ? (payeRefProblem(f.payeRef) ?? undefined) : undefined}>
                  {(p) => <input {...p} className="input" inputMode="numeric" value={f.payeRef} onChange={(e) => set('payeRef', e.target.value)} />}
                </Field>
              )}
              <label className="check">
                <input type="checkbox" checked={Boolean(f.uifRegistered)} onChange={(e) => set('uifRegistered', e.target.checked)} />
                <span>Registered for UIF</span>
              </label>
              {f.uifRegistered && (
                <Field label="UIF reference" hint="1234567/8 from the Department of Employment and Labour, or SARS’s U-number" error={f.uifRef !== settings.uifRef ? (uifRefProblem(f.uifRef) ?? undefined) : undefined}>
                  {(p) => <input {...p} className="input" value={f.uifRef} onChange={(e) => set('uifRef', e.target.value)} />}
                </Field>
              )}
            </div>
            {(!f.payeRegistered || !f.uifRegistered) && (
              <p className="xs banner">
                {!f.payeRegistered && 'Paying employees without a PAYE registration: an employer must register within 21 business days of becoming one, unless no employee earns enough to pay tax. '}
                {!f.uifRegistered && 'UIF covers anyone working 24 hours a month or more for you. '}
                Shap works out the deductions; registering, declaring and paying are your responsibility.
              </p>
            )}
          </div>
        )}
      </section>
      <section className="panel panel-pad stack">
        <h3>Logo</h3>
        <LogoField logoId={logoId} layout={f.logoLayout} accent={f.accent} onLogo={(id) => (setLogoId(id), void refreshReference())} onLayout={(l) => set('logoLayout', l)} />
      </section>
      {error && <div className="banner alert small">{error}</div>}
      <button className="btn primary big block" disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

/** Switch parts of the app off that a business like yours doesn't need; how Shap talks; what it may share. */
function Sections() {
  const { settings, refreshReference } = useAuthed();
  const toast = useToast();
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(FEATURE_KEYS.map((k) => [k, featureOn(settings.features, k)])));
  const [prefs, setPrefs] = useState({ tone: settings.tone, industry: settings.industry, usageConsent: settings.usageConsent, marketConsent: settings.marketConsent, sdl: settings.sdl, watermark: settings.watermark });
  const save = async (changes: Partial<Settings>, done: string) => {
    try {
      await saveSettings(settings, changes);
      await refreshReference();
      const merged = { ...settings, ...changes };
      if (merged.usageConsent) void reportUsage(merged);
      toast(done);
      return true;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save', 'error');
      return false;
    }
  };
  const toggle = async (k: (typeof FEATURE_KEYS)[number], value: boolean) => {
    const next = { ...on, [k]: value };
    setOn(next);
    if (!(await save({ features: next }, `${FEATURES[k].label} ${value ? 'on' : 'off'}`))) setOn(on);
  };
  // Choosing here also counts as having been told about it (so no note on Home).
  const marketPref = async (v: boolean) => {
    setPrefs({ ...prefs, marketConsent: v });
    if (!(await save({ marketConsent: v, marketNoticeSeen: true }, v ? 'Prices are shared anonymously' : 'Prices aren’t shared'))) setPrefs(prefs);
  };
  const pref = async <K extends keyof typeof prefs>(k: K, v: (typeof prefs)[K]) => {
    const next = { ...prefs, [k]: v };
    setPrefs(next);
    if (k === 'tone') setTone(v as Tone);
    if (!(await save({ [k]: v } as Partial<Settings>, 'Saved'))) setPrefs(prefs);
  };
  return (
    <div className="stack-lg narrow-wide">
      <section className="panel">
        <div className="panel-head">
          <strong>What you use</strong>
          <div className="xs muted">Switch off what a business like yours doesn’t need. Nothing is deleted: switch it on again and it’s all still there.</div>
        </div>
        {FEATURE_GROUPS.map((g) => (
          <div key={g.label}>
            <div className="list-group-head xs muted">{g.label}</div>
            <ul className="list">
              {g.keys.filter((k) => k !== 'dividends' || paysOutProfit(settings.businessType)).map((k) => (
                <li key={k} className="list-row">
                  <label className="check grow">
                    <input type="checkbox" checked={on[k] || (k === 'dividends' && entity(settings.businessType).dividendsTax)} disabled={k === 'dividends' && entity(settings.businessType).dividendsTax} onChange={(e) => void toggle(k, e.target.checked)} />
                    <span>
                      {FEATURES[k].label}
                      <div className="xs muted">{k === 'dividends' && entity(settings.businessType).dividendsTax ? `Always on for ${entity(settings.businessType).the}: every ${payoutWord(settings.businessType)} paid is declared to SARS on the DTR01 by the end of the next month.` : FEATURES[k].hint}</div>
                    </span>
                  </label>
                </li>
              ))}
              {g.keys.includes('payroll') && on.payroll && (
                <li className="list-row">
                  <label className="check grow">
                    <input type="checkbox" checked={prefs.sdl} onChange={(e) => void pref('sdl', e.target.checked)} />
                    <span>
                      Registered for the Skills Development Levy
                      <div className="xs muted">Once your payroll is expected to pass R500 000 over the next 12 months: 1% of salaries, paid by you.</div>
                    </span>
                  </label>
                </li>
              )}
            </ul>
          </div>
        ))}
        {(on.payshap || on.proformas || on.creditNotes) && (
          <p className="xs muted panel-pad" style={{ paddingTop: 0 }}>
            Numbering for credit notes and pro-formas, and your ShapID, are under <Link to="/settings?tab=invoicing">Invoicing &amp; tax</Link>.
          </p>
        )}
      </section>
      <section className="panel panel-pad stack">
        <h3>How Shap talks to you</h3>
        <div className="row wrap">
          <button type="button" className={`btn ${prefs.tone !== 'formal' ? 'primary' : ''}`} onClick={() => void pref('tone', 'casual')}>
            Lekker and casual
          </button>
          <button type="button" className={`btn ${prefs.tone === 'formal' ? 'primary' : ''}`} onClick={() => void pref('tone', 'formal')}>
            Formal
          </button>
        </div>
        <p className="xs muted">Only the app’s greetings and confirmations change. Quotes and invoices always stay professional.</p>
        <label className="check">
          <input type="checkbox" checked={prefs.watermark} onChange={(e) => void pref('watermark', e.target.checked)} />
          <span>
            Sign off with the Shap line
            <div className="xs muted">A small line at the foot of quotes, invoices and payslips: “{SHAP_LINE}” Thanks for spreading the word.</div>
          </span>
        </label>
      </section>
      <section className="panel panel-pad stack">
        <h3>Your kind of business</h3>
        <p className="xs muted">The examples, the names of line types on your quotes and invoices, the usual items offered when you add a line, and the cost types follow this.</p>
        <Field label="What you do">
          {(p) => (
            <select {...p} className="select" value={prefs.industry} onChange={(e) => void pref('industry', e.target.value)}>
              <option value="">Not said</option>
              {INDUSTRIES.map((i) => (
                <option key={i.key} value={i.key}>
                  {i.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="check">
          <input type="checkbox" checked={prefs.usageConsent} onChange={(e) => void pref('usageConsent', e.target.checked)} />
          <span>
            Let OpenWorks know, anonymously, what kind of business uses Shap
            <div className="xs muted">Only the kind of business and which parts are switched on, after an update and about once a month. Never names, clients or figures.</div>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.marketConsent} onChange={(e) => void marketPref(e.target.checked)} />
          <span>
            Share anonymous prices, to help show what work typically costs
            <div>
              <MarketWhat />
            </div>
          </span>
        </label>
      </section>
      <SupportShap />
    </div>
  );
}

function SettingsForm({ section }: { section: 'company' | 'invoicing' }) {
  const { settings, ref, refreshReference, has } = useAuthed();
  const toast = useToast();
  const [f, setF] = useState<Settings>({ ...settings });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((x) => ({ ...x, [k]: v }));
  const kind = entity(f.businessType);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      // Only this form's fields: switches and preferences saved elsewhere since it opened stay as they are now.
      const { logoId: _l, features: _f, tone: _t, industry: _i, usageConsent: _u, sdl: _s, watermark: _w, ...rest } = f as Settings & { logoId: string | null };
      await saveSettings(settings, rest);
      await refreshReference();
      toast('Settings saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };
  const text = (k: keyof Settings, label: string, hint?: string, type = 'text') => (
    <Field label={label} hint={hint}>
      {(p) => <input {...p} className="input" type={type} value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value as never)} />}
    </Field>
  );
  const sourceSelect = (k: 'defaultReceiptSourceId' | 'defaultWageSourceId' | 'defaultCostSourceId', label: string) => (
    <Field label={label}>
      {(p) => (
        <select {...p} className="select" value={f[k] ?? ''} onChange={(e) => set(k, e.target.value || null)}>
          {ref.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
  return (
    <form className="stack-lg narrow-wide" onSubmit={save}>
      {section === 'company' ? (
        <>
          <section className="panel panel-pad stack">
            <h3>The company</h3>
            <p className="xs muted">The registered company. How it presents itself on quotes and invoices (name, logo, contacts, bank) is set per trading name below.</p>
            <div className="form-grid">
              {text('companyName', 'Registered name', 'e.g. Example Builders (Pty) Ltd')}
              {text('regNumber', kind.regLabel ?? 'Registration number')}
              {text('vatNumber', 'VAT number')}
            </div>
            {ref.brands.length > 1 && (
              <Field label="Default trading name" hint="For new jobs and documents when the job or client doesn’t say">
                {(p) => (
                  <select {...p} className="select" value={f.defaultBrandId ?? ''} onChange={(e) => set('defaultBrandId', e.target.value || null)}>
                    {ref.brands.filter((b) => b.active).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="panel panel-pad stack">
            <h3>Numbering</h3>
            <div className="form-grid">
              {text('invoicePrefix', 'Invoice prefix', 'e.g. INV- (blank for plain numbers)')}
              <Field label="Next invoice number">{(p) => <input {...p} className="input" type="number" min={1} value={f.invoiceNext} onChange={(e) => set('invoiceNext', Number(e.target.value))} />}</Field>
              <Field label="Pad to digits" hint="4 makes 95 into 0095">{(p) => <input {...p} className="input" type="number" min={0} max={8} value={f.invoicePad} onChange={(e) => set('invoicePad', Number(e.target.value))} />}</Field>
              {text('quotePrefix', 'Quote prefix')}
              <Field label="Next quote number">{(p) => <input {...p} className="input" type="number" min={1} value={f.quoteNext} onChange={(e) => set('quoteNext', Number(e.target.value))} />}</Field>
              <Field label="Pad to digits">{(p) => <input {...p} className="input" type="number" min={0} max={8} value={f.quotePad} onChange={(e) => set('quotePad', Number(e.target.value))} />}</Field>
            </div>
            {(has('creditNotes') || has('proformas')) && (
              <div className="form-grid">
                {has('creditNotes') && text('creditPrefix', 'Credit note prefix', 'Credit notes have their own numbers')}
                {has('creditNotes') && <Field label="Next credit note number">{(p) => <input {...p} className="input" type="number" min={1} value={f.creditNext} onChange={(e) => set('creditNext', Number(e.target.value))} />}</Field>}
                {has('proformas') && text('proformaPrefix', 'Pro-forma prefix', 'Pro-formas aren’t tax invoices, so they’re numbered apart')}
                {has('proformas') && <Field label="Next pro-forma number">{(p) => <input {...p} className="input" type="number" min={1} value={f.proformaNext} onChange={(e) => set('proformaNext', Number(e.target.value))} />}</Field>}
              </div>
            )}
            <p className="xs muted">
              Next invoice: <strong>{`${f.invoicePrefix}${String(f.invoiceNext).padStart(f.invoicePad, '0')}`}</strong> · next quote:{' '}
              <strong>{`${f.quotePrefix}${String(f.quoteNext).padStart(f.quotePad, '0')}`}</strong>
              {has('creditNotes') && (
                <>
                  {' '}
                  · next credit note: <strong>{`${f.creditPrefix}${String(f.creditNext).padStart(f.creditPad, '0')}`}</strong>
                </>
              )}
              {has('proformas') && (
                <>
                  {' '}
                  · next pro-forma: <strong>{`${f.proformaPrefix}${String(f.proformaNext).padStart(f.quotePad, '0')}`}</strong>
                </>
              )}
            </p>
          </section>
          <section className="panel panel-pad stack">
            <h3>Terms</h3>
            <div className="form-grid">
              <Field label="Invoices due after (days)">{(p) => <input {...p} className="input" type="number" min={0} value={f.paymentDays} onChange={(e) => set('paymentDays', Number(e.target.value))} />}</Field>
              <Field label="Quotes valid for (days)">{(p) => <input {...p} className="input" type="number" min={0} value={f.quoteValidDays} onChange={(e) => set('quoteValidDays', Number(e.target.value))} />}</Field>
              <Field label="Mark-up on job costs (%)" hint="Used by “Charge job costs” and quotes from a parts plan">
                {(p) => <input {...p} className="input" type="number" min={0} step={1} value={f.markupBp / 100} onChange={(e) => set('markupBp', Math.round(Number(e.target.value) * 100))} />}
              </Field>
            </div>
            <Field label="Card payment link (optional)" hint="A Yoco (or SnapScan) payment link: printed on unpaid invoices and added to the message when you send one. Any invoice can have its own.">
              {(p) => <input {...p} className="input" type="url" inputMode="url" value={f.payLink} onChange={(e) => set('payLink', e.target.value)} placeholder="https://pay.yoco.com/…" />}
            </Field>
            {has('timeTracker') && (
              <Field label="Usual hourly rate" hint="For time on the clock: jobs can set their own, and time with no job uses this.">
                {(p) => <MoneyInput {...p} value={f.hourlyRateCents || null} onChange={(c) => set('hourlyRateCents', c ?? 0)} placeholder="e.g. 450" />}
              </Field>
            )}
            {has('payshap') && (
              <Field label="Your ShapID (PayShap)" hint="Your cellphone number or the ShapID your bank gave you. Printed on unpaid invoices so clients pay you instantly from their banking app (up to R50 000 at most banks).">
                {(p) => <input {...p} className="input" value={f.payshapId} onChange={(e) => set('payshapId', e.target.value)} placeholder="e.g. 082 123 4567 or yourname@yourbank" />}
              </Field>
            )}
            <Field label="Invoice terms">{(p) => <textarea {...p} className="textarea" rows={3} value={f.invoiceTerms} onChange={(e) => set('invoiceTerms', e.target.value)} />}</Field>
            <Field label="Quote terms">{(p) => <textarea {...p} className="textarea" rows={3} value={f.quoteTerms} onChange={(e) => set('quoteTerms', e.target.value)} />}</Field>
          </section>
          <section className="panel panel-pad stack">
            <h3>Tax, VAT and the financial year</h3>
            <Field label="This business is">
              {(p) => (
                <select {...p} className="select" value={f.businessType} onChange={(e) => {
                  const v = e.target.value as Settings['businessType'];
                  const k = entity(v);
                  // The same rules the server applies on saving (entities.ts).
                  setF((x) => ({ ...x, businessType: v, fyEndMonth: k.febYearEnd ? 2 : x.fyEndMonth, turnoverTax: k.turnoverTax && x.turnoverTax, approvedPbo: v === 'npc' && x.approvedPbo }));
                }}>
                  {BUSINESS_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {ENTITIES[t].label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <p className="xs muted">
              {kind.description} {kind.ownerMoney}
              {kind.febYearEnd && ' The year ends in February (SARS’s year).'}
            </p>
            {f.businessType === 'partnership' && settings.businessType !== 'partnership' && <div className="banner small">Save, then add the partners and their shares below.</div>}
            {f.businessType === 'npc' && (
              <label className="check">
                <input type="checkbox" checked={f.approvedPbo} onChange={(e) => set('approvedPbo', e.target.checked)} />
                <span>
                  Approved by SARS as a public benefit organisation (PBO)
                  <div className="xs muted">With the PBO letter, most of its income is tax-free and the tax estimate shows none. Trading beyond what the PBO rules allow (more than the greater of 5% of its receipts or R200 000) is still taxed: your accountant works that out. Without the letter, it pays company tax.</div>
                </span>
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={f.vatRegistered} onChange={(e) => set('vatRegistered', e.target.checked)} />
              <span>
                Registered for VAT
                <div className="xs muted">New invoices add VAT and say “Tax invoice”; costs can record the VAT you claim back. Existing invoices keep what they had.</div>
              </span>
            </label>
            {!f.vatRegistered && <VatThreshold />}
            {f.vatRegistered && (
              <Field label="How often you file VAT" hint="On your VAT registration letter (VAT103). Used for the VAT201 periods and due dates.">
                {(p) => (
                  <select {...p} className="select" value={f.vatCategory} onChange={(e) => set('vatCategory', e.target.value as Settings['vatCategory'])}>
                    <option value="A">Every two months, ending in odd months (Category A: Jan, Mar, May…)</option>
                    <option value="B">Every two months, ending in even months (Category B: Feb, Apr, Jun…)</option>
                    <option value="C">Every month (Category C)</option>
                  </select>
                )}
              </Field>
            )}
            {kind.turnoverTax && <label className="check">
              <input type="checkbox" checked={f.turnoverTax} onChange={(e) => set('turnoverTax', e.target.checked)} />
              <span>
                Registered for turnover tax
                <div className="xs muted">
                  SARS’s simpler tax for micro businesses (turnover up to {formatZar(TURNOVER_TAX_LIMIT_CENTS)} a year): a small percentage of turnover instead of income
                  tax on profit, and no provisional tax. Only if you registered for it (form TT01). The tax estimate switches to it.
                  {kind.taxedAs === 'company' && ' For now a company on turnover tax needs its year to end in February (the 2026 Budget proposed dropping this; it isn’t law yet).'}
                  {kind.taxedAs === 'partners' && ' Each partner registers and pays on their own share of the turnover.'}
                </div>
              </span>
            </label>}
            <div className="form-grid">
              {f.vatRegistered && <Field label="VAT rate (%)">{(p) => <input {...p} className="input" type="number" step="0.5" value={f.vatRateBp / 100} onChange={(e) => set('vatRateBp', Math.round(Number(e.target.value) * 100))} />}</Field>}
              <Field label="Financial year ends in" hint={kind.febYearEnd ? `February: SARS’s tax year for ${kind.taxedAs === 'trust' ? 'trusts' : 'individuals'}` : undefined}>
                {(p) => (
                  <select {...p} className="select" value={f.fyEndMonth} onChange={(e) => set('fyEndMonth', Number(e.target.value))} disabled={kind.febYearEnd}>
                    {MONTHS.map((m, i) => (
                      <option key={m} value={i + 1}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Books closed up to" hint="Nothing on or before this date can be changed. Set it once your accountant signs off a year.">
                {(p) => <input {...p} className="input" type="date" value={f.lockDate ?? ''} onChange={(e) => set('lockDate', e.target.value || null)} />}
              </Field>
            </div>
          </section>
          <section className="panel panel-pad stack">
            <h3>Defaults</h3>
            <div className="form-grid">
              {sourceSelect('defaultCostSourceId', 'Costs are usually paid from')}
              {sourceSelect('defaultWageSourceId', 'Wages are usually paid from')}
              {sourceSelect('defaultReceiptSourceId', 'Clients usually pay into')}
            </div>
          </section>
        </>
      )}
      {error && <div className="banner alert small">{error}</div>}
      <div>
        <button className="btn primary big" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------- lists */
type ListKind = 'sources' | 'categories' | 'work-types' | 'accounts';

function Lists() {
  const { ref, refreshReference, words } = useAuthed();
  const [edit, setEdit] = useState<{ kind: ListKind; row: Record<string, unknown> | null } | null>(null);
  const acc = (id: string) => ref.accounts.find((a) => a.id === id);
  return (
    <div className="stack-lg">
      <section className="panel">
        <div className="panel-head spread">
          <span>
            <strong>Paid from / paid into</strong>
            <div className="xs muted">Your bank account, each card, cash. Each one says which account in the books it belongs to: cards in your own name go to your {words.ownerAccount}.</div>
          </span>
          <button className="btn small" onClick={() => setEdit({ kind: 'sources', row: null })}>
            <Icon name="plus" size={14} />
            Add
          </button>
        </div>
        <ListTable
          rows={ref.sources.map((s) => ({ id: s.id, cells: [s.name, SOURCE_KIND_LABELS[s.kind], `${s.accountCode} ${s.accountName}`], active: s.active, raw: s }))}
          head={['Name', 'Kind', 'Posts to']}
          onEdit={(raw) => setEdit({ kind: 'sources', row: raw })}
        />
      </section>
      <section className="panel">
        <div className="panel-head spread">
          <span>
            <strong>Cost types</strong>
            <div className="xs muted">The tracker’s “Type”. Change where one lands in the books and every cost of that type moves with it.</div>
          </span>
          <button className="btn small" onClick={() => setEdit({ kind: 'categories', row: null })}>
            <Icon name="plus" size={14} />
            Add
          </button>
        </div>
        <ListTable
          rows={ref.categories.map((c) => ({ id: c.id, cells: [c.name, CATEGORY_KIND_LABELS[c.kind], `${c.accountCode} ${c.accountName}`], active: c.active, raw: c }))}
          head={['Name', 'Treated as', 'Posts to']}
          onEdit={(raw) => setEdit({ kind: 'categories', row: raw })}
        />
      </section>
      <section className="panel">
        <div className="panel-head spread">
          <span>
            <strong>General work</strong>
            <div className="xs muted">For labour that isn’t on a job.</div>
          </span>
          <button className="btn small" onClick={() => setEdit({ kind: 'work-types', row: null })}>
            <Icon name="plus" size={14} />
            Add
          </button>
        </div>
        <ListTable rows={ref.workTypes.map((w) => ({ id: w.id, cells: [w.name], active: w.active, raw: w }))} head={['Name']} onEdit={(raw) => setEdit({ kind: 'work-types', row: raw })} />
      </section>
      <section className="panel">
        <div className="panel-head spread">
          <span>
            <strong>Chart of accounts</strong>
            <div className="xs muted">Rename accounts to match your accountant’s, or add your own. Shap posts to the marked ones by itself.</div>
          </span>
          <button className="btn small" onClick={() => setEdit({ kind: 'accounts', row: null })}>
            <Icon name="plus" size={14} />
            Add
          </button>
        </div>
        <ListTable
          rows={ref.accounts.map((a) => ({ id: a.id, cells: [a.code, a.name, ACCOUNT_TYPE_LABELS[a.type] + (a.systemKey ? ' · automatic' : '')], active: a.active, raw: a }))}
          head={['Code', 'Name', 'Type']}
          onEdit={(raw) => setEdit({ kind: 'accounts', row: raw })}
        />
      </section>
      {edit && <ListDrawer kind={edit.kind} row={edit.row} accountName={(id) => acc(id)?.name ?? ''} onClose={() => setEdit(null)} onSaved={refreshReference} />}
    </div>
  );
}

function ListTable({ rows, head, onEdit }: { rows: { id: string; cells: string[]; active: boolean; raw: unknown }[]; head: string[]; onEdit: (raw: Record<string, unknown>) => void }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`clickable ${r.active ? '' : 'inactive'}`} onClick={() => onEdit(r.raw as Record<string, unknown>)}>
              {r.cells.map((c, i) => (
                <td key={i}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListDrawer({ kind, row, onClose, onSaved }: { kind: ListKind; row: Record<string, unknown> | null; accountName: (id: string) => string; onClose: () => void; onSaved: () => Promise<void> }) {
  const { ref } = useAuthed();
  const toast = useToast();
  const [f, setF] = useState<Record<string, unknown>>(
    row ?? (kind === 'sources' ? { name: '', kind: 'card', accountId: ref.accounts.find((a) => a.systemKey === 'owner_loan')?.id, active: true } : kind === 'categories' ? { name: '', kind: 'overhead', accountId: ref.accounts.find((a) => a.systemKey === 'sundry')?.id, active: true } : kind === 'accounts' ? { code: '', name: '', type: 'expense', active: true } : { name: '', active: true }),
  );
  const [error, setError] = useState('');
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = kind === 'sources' ? { name: f.name, kind: f.kind, accountId: f.accountId, active: f.active, statementsRequired: Boolean(f.statementsRequired), statementsFrom: f.statementsRequired && f.statementsFrom ? f.statementsFrom : null } : kind === 'categories' ? { name: f.name, kind: f.kind, accountId: f.accountId, active: f.active } : kind === 'accounts' ? { code: f.code, name: f.name, type: f.type, active: f.active } : { name: f.name, active: f.active };
    try {
      if (row) await api(`/api/${kind}/${row.id as string}`, { method: 'PUT', body });
      else await api(`/api/${kind}`, { body });
      await onSaved();
      toast('Saved');
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  const accountSelect = (filter: (t: AccountType) => boolean) => (
    <Field label="Posts to account">
      {(p) => (
        <select {...p} className="select" value={String(f.accountId ?? '')} onChange={(e) => set('accountId', e.target.value)}>
          {ref.accounts.filter((a) => filter(a.type)).map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
  const title = { sources: 'Paid from / into', categories: 'Cost type', 'work-types': 'General work', accounts: 'Account' }[kind];
  return (
    <Drawer title={row ? `${title}: ${String(row.name)}` : `New ${title.toLowerCase()}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {kind === 'accounts' && <Field label="Code">{(p) => <input {...p} className="input" value={String(f.code ?? '')} onChange={(e) => set('code', e.target.value)} required />}</Field>}
        <Field label="Name">{(p) => <input {...p} className="input" value={String(f.name ?? '')} onChange={(e) => set('name', e.target.value)} required autoFocus />}</Field>
        {kind === 'sources' && (
          <>
            <Field label="Kind">
              {(p) => (
                <select {...p} className="select" value={String(f.kind)} onChange={(e) => set('kind', e.target.value as SourceKind)}>
                  {SOURCE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {SOURCE_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {accountSelect((t) => t === 'asset' || t === 'liability' || t === 'equity')}
            {f.kind !== 'cash' && (
              <div className="fieldset stack" style={{ gap: 6 }}>
                <label className="check">
                  <input type="checkbox" checked={Boolean(f.statementsRequired)} onChange={(e) => set('statementsRequired', e.target.checked)} />
                  <span>
                    Keep its monthly statement (PDF) on file
                    <div className="xs muted">Home reminds you of months not uploaded yet (Accounts → Statement PDFs), and the accountant can download them.</div>
                  </span>
                </label>
                {Boolean(f.statementsRequired) && (
                  <Field label="From" hint="The first month you want on file">
                    {(p) => (
                      <input
                        {...p}
                        className="input"
                        type="month"
                        value={String(f.statementsFrom ?? '').slice(0, 7)}
                        onChange={(e) => set('statementsFrom', e.target.value ? `${e.target.value}-01` : null)}
                        style={{ maxWidth: 200 }}
                      />
                    )}
                  </Field>
                )}
              </div>
            )}
          </>
        )}
        {kind === 'categories' && (
          <>
            <Field label="Treated as">
              {(p) => (
                <select {...p} className="select" value={String(f.kind)} onChange={(e) => set('kind', e.target.value as CategoryKind)}>
                  {CATEGORY_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {CATEGORY_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {accountSelect(() => true)}
          </>
        )}
        {kind === 'accounts' && (
          <Field label="Type" hint={row?.systemKey ? 'Shap posts to this account itself, so its type stays fixed.' : undefined}>
            {(p) => (
              <select {...p} className="select" value={String(f.type)} onChange={(e) => set('type', e.target.value as AccountType)} disabled={Boolean(row?.systemKey)}>
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ACCOUNT_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <label className="check">
          <input type="checkbox" checked={Boolean(f.active)} onChange={(e) => set('active', e.target.checked)} />
          In use
        </label>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
      </form>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- users */
/* ---------------------------------------------------------------- trading names */
function TradingNames() {
  const { ref } = useAuthed();
  const [edit, setEdit] = useState<Brand | 'new' | null>(null);
  return (
    <section className="panel narrow-wide">
      <div className="panel-head spread">
        <span>
          <strong>Trading names</strong>
          <div className="xs muted">One company, several names on the door. Each quote, invoice and job picks one; numbering and the books are shared.</div>
        </span>
        <button className="btn small" onClick={() => setEdit('new')}>
          <Icon name="plus" size={14} />
          Add
        </button>
      </div>
      <ul className="list">
        {ref.brands.map((b) => (
          <li key={b.id}>
            <button className={`list-row ${b.active ? '' : 'inactive'}`} onClick={() => setEdit(b)}>
              <span className="brand-swatch" style={{ background: b.accent }} />
              {b.logoId ? <ApiImage path={`/api/attachments/${b.logoId}`} alt="" className="brand-logo" /> : <span className="brand-logo empty">No logo</span>}
              <span className="grow">
                <strong>{b.name}</strong>
                {ref.settings.defaultBrandId === b.id && <span className="chip" style={{ marginLeft: 8 }}>default</span>}
                <div className="xs muted ellipsis">{[b.email, b.phone, b.website].filter(Boolean).join(' · ') || 'No contact details yet'}</div>
              </span>
              <Icon name="chevronRight" size={16} />
            </button>
          </li>
        ))}
      </ul>
      {edit && <BrandDrawer brand={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function BrandDrawer({ brand, onClose }: { brand: Brand | null; onClose: () => void }) {
  const { refreshReference, settings } = useAuthed();
  const toast = useToast();
  const [f, setF] = useState({
    name: brand?.name ?? '',
    legalLine: brand?.legalLine ?? (settings.companyName ? `${settings.companyName} t/a ` : ''),
    email: brand?.email ?? '',
    phone: brand?.phone ?? '',
    website: brand?.website ?? '',
    address: brand?.address ?? '',
    bankDetails: brand?.bankDetails ?? '',
    accent: brand?.accent ?? '#e8731c',
    active: brand?.active ?? true,
  });
  const [logoId, setLogoId] = useState(brand?.logoId ?? null);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (brand) await api(`/api/brands/${brand.id}`, { method: 'PUT', body: f });
      else await api('/api/brands', { body: f });
      await refreshReference();
      toast('Trading name saved');
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  const uploadLogo = async (file: File | undefined) => {
    if (!file || !brand) return;
    try {
      const img = file.type === 'image/png' ? await cleanPngLogo(file) : await shrinkImage(file, 1200, 0.9);
      const r = await api<{ logoId: string }>(`/api/brands/${brand.id}/logo`, { body: img });
      setLogoId(r.logoId);
      await refreshReference();
      toast('Logo saved');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t upload the logo', 'error');
    }
  };
  return (
    <Drawer title={brand ? brand.name : 'New trading name'} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Trading name">{(p) => <input {...p} className="input" value={f.name} onChange={(e) => set('name', e.target.value)} required placeholder="e.g. OpenWorks IT" />}</Field>
        <Field label="Legal line" hint="Printed under the name and in the footer">
          {(p) => <input {...p} className="input" value={f.legalLine} onChange={(e) => set('legalLine', e.target.value)} placeholder="Company (Pty) Ltd t/a Trading name" />}
        </Field>
        <div className="form-grid">
          <Field label="Email">{(p) => <input {...p} className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}</Field>
          <Field label="Phone">{(p) => <input {...p} className="input" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />}</Field>
          <Field label="Website">{(p) => <input {...p} className="input" value={f.website} onChange={(e) => set('website', e.target.value)} />}</Field>
        </div>
        <Field label="Address">{(p) => <textarea {...p} className="textarea" rows={3} value={f.address} onChange={(e) => set('address', e.target.value)} />}</Field>
        <Field label="Bank details (printed on invoices)">
          {(p) => <textarea {...p} className="textarea" rows={3} value={f.bankDetails} onChange={(e) => set('bankDetails', e.target.value)} placeholder={'FNB · Cheque account\nAccount 62xxxxxxxxx · Branch 250655'} />}
        </Field>
        <Field label="Colour" hint="Headings and the amount-due box on the PDF">
          {(p) => (
            <div className="row">
              <input {...p} type="color" value={f.accent} onChange={(e) => set('accent', e.target.value)} className="color-input" />
              <input className="input" value={f.accent} onChange={(e) => set('accent', e.target.value)} style={{ maxWidth: 120 }} aria-label="Colour code" />
            </div>
          )}
        </Field>
        <div className="field">
          <span className="label">Logo</span>
          {brand ? (
            <div className="row wrap">
              {logoId && <ApiImage path={`/api/attachments/${logoId}`} alt={`${f.name} logo`} className="logo-preview" />}
              <label className="btn">
                <Icon name="upload" size={18} />
                {logoId ? 'Replace logo' : 'Upload a logo'}
                <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => void uploadLogo(e.target.files?.[0])} />
              </label>
              {logoId && (
                <button type="button" className="btn quiet" onClick={() => void api(`/api/brands/${brand.id}/logo`, { method: 'DELETE' }).then(() => (setLogoId(null), refreshReference()))}>
                  Remove
                </button>
              )}
            </div>
          ) : (
            <span className="xs muted">Save first, then add the logo. A wide logo (wider than tall) suits the invoice best.</span>
          )}
        </div>
        {brand && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
            In use
          </label>
        )}
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
      </form>
    </Drawer>
  );
}

/** Not registered for VAT: how close the last 12 months are to the point where you must. */
function VatThreshold() {
  const { data } = useApi<{ last12Cents: number; peak12Cents: number; peakTo: string; pace12Cents: number; compulsoryCents: number; voluntaryCents: number; state: 'over' | 'near' | 'voluntary' | null }>('/api/vat/threshold');
  if (!data) return null;
  const pct = Math.min(100, Math.round((data.peak12Cents / data.compulsoryCents) * 100));
  const earlier = data.peak12Cents !== data.last12Cents;
  return (
    <div className={`banner small${data.state === 'over' || data.state === 'near' ? ' alert' : ''}`}>
      <strong>{formatZar(data.last12Cents)}</strong> of income in the last 12 months
      {earlier && (
        <>
          {' '}
          (and <strong>{formatZar(data.peak12Cents)}</strong> in the 12 months to {formatDate(data.peakTo)}, the highest run)
        </>
      )}
      : {pct}% of the {formatZar(data.compulsoryCents)} at which VAT registration is compulsory. Any 12 months in a row count, not only a tax year.{' '}
      {data.state === 'over'
        ? 'That’s over the line: you must register with SARS within 21 days of passing it.'
        : data.state === 'near'
          ? `Getting close${data.pace12Cents > data.compulsoryCents ? `: the last three months are running at ${formatZar(data.pace12Cents)} over 12 months` : ''}. Talk to your accountant about registering before you pass it.`
          : data.state === 'voluntary'
            ? `You may register voluntarily (from ${formatZar(data.voluntaryCents)}), but you don’t have to yet.`
            : 'Nothing to do yet.'}{' '}
      <span className="muted">Shap counts all income in the books, so exempt income (interest, residential rent) makes this a little high.</span>
    </div>
  );
}
