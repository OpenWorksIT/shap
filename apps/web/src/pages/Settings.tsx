import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPES,
  CATEGORY_KIND_LABELS,
  CATEGORY_KINDS,
  formatDate,
  formatZar,
  monthLabel,
  passwordProblem,
  ROLE_HINTS,
  ROLE_LABELS,
  SHAP_LINE,
  ROLES,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  type AccountType,
  type CategoryKind,
  type Role,
  type SourceKind,
} from '@shap/shared';
import { PageHead } from '../components/Shell';
import { Drawer, ErrorBox, Field, Icon, Loading, MoneyInput, Tabs, useToast } from '../components/ui';
import { api, ApiError, apiUrl } from '../lib/api';
import { fileToBase64, shrinkImage } from '../lib/files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { Brand, Settings } from '../lib/types';
import { SystemSettings } from './System';
import { FeedbackInbox } from './FeedbackInbox';
import { LogoPlacer } from '../components/LogoPlacer';
import { LogoField } from '../components/BusinessForm';
import { FEATURES, FEATURE_GROUPS, FEATURE_KEYS, featureOn, INDUSTRIES, TURNOVER_TAX_LIMIT_CENTS } from '@shap/shared';
import { WipeData } from '../components/WipeData';
import { setTone, type Tone } from '../lib/words';
import { SupportShap } from '../components/Support';
import { ShowDemoButton } from '../components/Demo';
import { usePasswordPrompt } from '../components/PasswordPrompt';

type Tab = 'company' | 'invoicing' | 'sections' | 'lists' | 'users' | 'import' | 'system' | 'feedback';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'company';
  const { isOwner, has } = useAuthed();
  return (
    <div className="stack-lg">
      <PageHead title="Settings" actions={isOwner ? <ShowDemoButton /> : undefined} />
      <div className="tabs-scroll">
        <Tabs<Tab>
          value={tab}
          onChange={(t) => setParams({ tab: t }, { replace: true })}
          tabs={[
            { value: 'company', label: 'Company' },
            { value: 'invoicing', label: 'Invoicing & books' },
            { value: 'sections', label: 'What you use' },
            { value: 'lists', label: 'Lists' },
            { value: 'users', label: 'People who sign in' },
            { value: 'import', label: 'Import & company file' },
            { value: 'system', label: 'Updates & backups' },
            { value: 'feedback', label: 'Feedback' },
          ]}
        />
      </div>
      {tab === 'company' && (
        <>
          <SettingsForm section="company" />
          {has('brands') ? <TradingNames /> : <BusinessDetails />}
        </>
      )}
      {tab === 'invoicing' && <SettingsForm section="invoicing" />}
      {tab === 'sections' && <Sections />}
      {tab === 'feedback' && <FeedbackInbox />}
      {tab === 'lists' && <Lists />}
      {tab === 'users' && <Users />}
      {tab === 'system' && (
        <>
          <SystemSettings />
          <WipeData />
        </>
      )}
      {tab === 'import' && (
        <>
          <section className="panel panel-pad stack narrow-wide">
            <h3>Coming from another package?</h3>
            <p className="small">Bring your clients, invoices (with what’s been paid), quotes, items, bills and opening balances from Sage, Xero, QuickBooks, Zoho or Invoice Ninja.</p>
            <Link className="btn primary" to="/move-in" style={{ alignSelf: 'flex-start' }}>
              <Icon name="upload" size={18} />
              Move in
            </Link>
          </section>
          <ImportTracker />
          <CompanyFile />
        </>
      )}
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
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await saveSettings(settings, formOnly(f));
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
            <p className="xs muted">The registered company. How it presents itself on quotes and invoices (name, logo, contacts, bank) is set below.</p>
            <div className="form-grid">
              {text('companyName', 'Registered name', 'e.g. Example Builders (Pty) Ltd')}
              {text('regNumber', 'Registration number')}
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
            <Field label="Card payment link (optional)" hint="A Yoco (or SnapScan) payment link: printed on unpaid invoices and added to the email. Any invoice can have its own.">
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
                  setF((x) => ({ ...x, businessType: v, fyEndMonth: v === 'sole_prop' ? 2 : x.fyEndMonth }));
                }}>
                  <option value="company">A company (Pty Ltd)</option>
                  <option value="sole_prop">Just me (sole proprietor)</option>
                </select>
              )}
            </Field>
            <p className="xs muted">
              {f.businessType === 'sole_prop'
                ? 'The profit is taxed as your own income, on the tables for individuals, and the year ends in February. Money you put in or take out goes to your owner’s account (capital and drawings): what you take out is not a cost.'
                : 'The company pays company tax (small business corporation rates if it qualifies). Money between you and the company goes on your loan account.'}
            </p>
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
            <label className="check">
              <input type="checkbox" checked={f.turnoverTax} onChange={(e) => set('turnoverTax', e.target.checked)} />
              <span>
                Registered for turnover tax
                <div className="xs muted">
                  SARS’s simpler tax for micro businesses (turnover up to {formatZar(TURNOVER_TAX_LIMIT_CENTS)} a year): a small percentage of turnover instead of income
                  tax on profit, and no provisional tax. Only if you registered for it (form TT01). The tax estimate switches to it.
                </div>
              </span>
            </label>
            <div className="form-grid">
              {f.vatRegistered && <Field label="VAT rate (%)">{(p) => <input {...p} className="input" type="number" step="0.5" value={f.vatRateBp / 100} onChange={(e) => set('vatRateBp', Math.round(Number(e.target.value) * 100))} />}</Field>}
              <Field label="Financial year ends in" hint={f.businessType === 'sole_prop' ? 'February: SARS’s tax year for individuals' : undefined}>
                {(p) => (
                  <select {...p} className="select" value={f.fyEndMonth} onChange={(e) => set('fyEndMonth', Number(e.target.value))} disabled={f.businessType === 'sole_prop'}>
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
interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  lastLoginAt: string | null;
  mfa: boolean;
}

function Users() {
  const { user } = useAuthed();
  const { data, error, reload } = useApi<UserRow[]>('/api/users');
  const [edit, setEdit] = useState<UserRow | 'new' | null>(null);
  return (
    <div className="stack">
      <div className="spread">
        <p className="small muted">Give your foreman a site login to log days and costs, and your accountant a read-only one.</p>
        <button className="btn primary" onClick={() => setEdit('new')}>
          <Icon name="plus" size={18} />
          Add someone
        </button>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : (
        <section className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Access</th>
                <th className="hide-sm">Two-factor</th>
                <th className="hide-sm">Last signed in</th>
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id} className={`clickable ${u.active ? '' : 'inactive'}`} onClick={() => setEdit(u)}>
                  <td>
                    <strong>{u.name}</strong>
                    {u.id === user.id && <span className="muted"> (you)</span>}
                    <div className="xs muted">{u.email}</div>
                  </td>
                  <td>{ROLE_LABELS[u.role]}</td>
                  <td className="hide-sm">{u.mfa ? 'On' : 'Off'}</td>
                  <td className="hide-sm">{u.lastLoginAt ? formatDate(u.lastLoginAt.slice(0, 10)) : 'Never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {edit && <UserDrawer user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={reload} />}
    </div>
  );
}

function UserDrawer({ user, onClose, onSaved }: { user: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { user: me } = useAuthed();
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', role: (user?.role ?? 'capture') as Role, password: '', active: user?.active ?? true, currentPassword: '' });
  const [error, setError] = useState('');
  const [passwordPrompt, askPassword] = usePasswordPrompt();
  const isMe = user?.id === me.id;
  // The acting owner re-enters their password for the high-impact moves (matching the server): your
  // own email/password, resetting someone else's password, making someone an owner, or editing an
  // existing owner — so a session left open on a phone can't take over or lock someone out.
  const resettingOther = Boolean(user) && !isMe && Boolean(f.password);
  const makingOwner = f.role === 'owner' && (!user || user.role !== 'owner');
  const editingOwner = Boolean(user) && !isMe && user?.role === 'owner';
  const needsCurrent =
    (isMe && (Boolean(f.password) || f.email.trim().toLowerCase() !== user?.email)) || resettingOther || makingOwner || editingOwner;
  const problem = f.password ? passwordProblem(f.password, f) : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...f, password: f.password || undefined, currentPassword: needsCurrent ? f.currentPassword : undefined };
      if (user) await api(`/api/users/${user.id}`, { method: 'PUT', body });
      else await api('/api/users', { body });
      toast('Saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title={user ? user.name : 'Add someone'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">{(p) => <input {...p} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />}</Field>
        <Field label="Email (they sign in with this)">{(p) => <input {...p} className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />}</Field>
        <div className="field">
          <span className="label">Access</span>
          {ROLES.map((r) => (
            <label key={r} className="check">
              <input type="radio" name="role" checked={f.role === r} onChange={() => setF({ ...f, role: r })} />
              <span>
                {ROLE_LABELS[r]}
                <div className="xs muted">{ROLE_HINTS[r]}</div>
              </span>
            </label>
          ))}
        </div>
        <Field label={user ? 'New password (leave blank to keep)' : 'Starting password'} hint={problem ?? (isMe ? 'At least 10 characters.' : 'At least 10 characters. They can change it under their name, top right.')} error={problem ?? undefined}>
          {(p) => <input {...p} className="input" type="text" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required={!user} minLength={user ? undefined : 10} />}
        </Field>
        {needsCurrent && (
          <Field label="Your current password" hint="Enter your password to confirm this change.">
            {(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} required />}
          </Field>
        )}
        {user && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            Can sign in
          </label>
        )}
        {error && <div className="banner alert small">{error}</div>}
        <div className="row wrap">
          <button className="btn primary">Save</button>
          {user?.mfa && (
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const password = await askPassword('Reset two-factor', isMe ? 'Enter your password to reset your own two-factor sign-in.' : 'Enter your password to reset this person’s two-factor sign-in.');
                if (!password) return;
                try {
                  await api(`/api/users/${user.id}/reset-mfa`, { body: { password } });
                  toast('Two-factor reset; they set it up again at next sign-in');
                  onSaved();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : 'Couldn’t reset it');
                }
              }}
            >
              Reset two-factor (lost phone)
            </button>
          )}
        </div>
      </form>
      {passwordPrompt}
    </Drawer>
  );
}

/* ---------------------------------------------------------------- tracker import */
interface Preview {
  clients: number;
  projects: number;
  projectsNotOnSheet: string[];
  invoices: number;
  costs: number;
  workers: string[];
  labour: number;
  unallocatedLabour: number;
  wagePayments: number;
  savings: number;
  accounts: string[];
  types: string[];
  trialBalance: { date: string; bankCents: number; ownerLoanCents: number; shareCapitalCents: number } | null;
  warnings: string[];
  skipped: { costsWithoutAmount: number; labourPlaceholders: number; savingsRows: number };
  firstDate: string | null;
  lastDate: string | null;
  companyEmpty: boolean;
}
interface Result {
  counts: Record<string, number>;
  jobsChecked: number;
  jobDifferences: { name: string; field: string; sheetCents: number; shapCents: number }[];
  warnings: string[];
  checks: { month: string; sheet: { invoicedCents: number; partsCents: number; labourCents: number }; shap: { invoicedCents: number; partsCents: number; labourCents: number } }[];
  agreement: { date: string; lines: { account: string; amountCents: number }[]; note: string } | null;
  sourceMapping: { account: string; source: string; postsTo: string }[];
}

function ImportTracker() {
  const { refreshReference } = useAuthed();
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [opts, setOpts] = useState({ replace: false, agreeTrialBalance: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = await fileToBase64(f);
      setFile({ name: f.name, data });
      const r = await api<{ preview: Preview }>('/api/import/tracker', { body: { dataBase64: data, apply: false } });
      setPreview(r.preview);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t read that file');
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ result: Result }>('/api/import/tracker', { body: { dataBase64: file.data, apply: true, ...opts } });
      setResult(r.result);
      await refreshReference();
      toast('Tracker imported');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import failed; nothing was changed');
    } finally {
      setBusy(false);
    }
  };

  if (result) return <ImportResult r={result} />;
  return (
    <div className="stack-lg narrow-wide">
      <section className="panel panel-pad stack">
        <h3>Bring your project tracker across</h3>
        <p className="small">
          Upload the Excel tracker (Per Project, Costs, Wages List…). Shap reads it, shows you what it found, and imports it in one go: clients, jobs and their
          invoices and payments, costs, workers, days and wage payments, savings. Nothing changes until you press Import.
        </p>
        <label className="btn primary big">
          <Icon name="upload" size={18} />
          {busy && !preview ? 'Reading…' : file ? `Choose another file (${file.name})` : 'Choose the .xlsx file'}
          <input type="file" accept=".xlsx" hidden onChange={(e) => void choose(e.target.files?.[0])} disabled={busy} />
        </label>
        {error && <div className="banner alert small">{error}</div>}
      </section>
      {preview && (
        <>
          <section className="panel panel-pad stack">
            <h3>What’s in it</h3>
            <div className="kpis compact">
              <div className="kpi"><div className="kpi-label">Jobs</div><div className="kpi-value">{preview.projects}</div><div className="kpi-sub">{preview.invoices} invoiced</div></div>
              <div className="kpi"><div className="kpi-label">Costs</div><div className="kpi-value">{preview.costs}</div></div>
              <div className="kpi"><div className="kpi-label">Labour days</div><div className="kpi-value">{preview.labour}</div><div className="kpi-sub">{preview.unallocatedLabour} without a job</div></div>
              <div className="kpi"><div className="kpi-label">Wage payments</div><div className="kpi-value">{preview.wagePayments}</div></div>
              <div className="kpi"><div className="kpi-label">Clients</div><div className="kpi-value">{preview.clients}</div></div>
            </div>
            <p className="small muted">
              {preview.firstDate && `From ${formatDate(preview.firstDate)} to ${formatDate(preview.lastDate)}. `}Workers: {preview.workers.join(', ')}.
            </p>
            {preview.warnings.length > 0 && (
              <ul className="small warn-list">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel panel-pad stack">
            <h3>Before you import</h3>
            <p className="small muted">
              Costs with a blank “Account” come in as <em>not captured yet</em>: Shap won’t guess what paid them. Afterwards, Costs → “Not captured yet” lets you
              tick them off in batches.
            </p>
            {preview.trialBalance && (
              <label className="check">
                <input type="checkbox" checked={opts.agreeTrialBalance} onChange={(e) => setOpts({ ...opts, agreeTrialBalance: e.target.checked })} />
                <span>
                  Agree the books to the trial balance at {formatDate(preview.trialBalance.date)}
                  <div className="xs muted">
                    Bank {formatZar(preview.trialBalance.bankCents)}, loan {formatZar(preview.trialBalance.ownerLoanCents)}, share capital {formatZar(preview.trialBalance.shareCapitalCents)}. One journal does it; anything left over goes to Suspense.
                  </div>
                </span>
              </label>
            )}
            {!preview.companyEmpty && (
              <label className="check">
                <input type="checkbox" checked={opts.replace} onChange={(e) => setOpts({ ...opts, replace: e.target.checked })} />
                <span>
                  Replace what’s there
                  <div className="xs muted">Shap already has jobs or costs. Ticking this deletes them (and their invoices) first. Settings, users and lists stay.</div>
                </span>
              </label>
            )}
            <button className="btn primary big" disabled={busy || (!preview.companyEmpty && !opts.replace)} onClick={() => void run()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </section>
        </>
      )}
    </div>
  );
}

function ImportResult({ r }: { r: Result }) {
  const off = r.checks.filter((c) => c.sheet.invoicedCents !== c.shap.invoicedCents || c.sheet.partsCents !== c.shap.partsCents || c.sheet.labourCents !== c.shap.labourCents);
  const sum = (k: 'invoicedCents' | 'partsCents' | 'labourCents', w: 'sheet' | 'shap') => r.checks.reduce((s, c) => s + c[w][k], 0);
  const cell = (a: number, b: number) => (a === b ? <span className="ok-text">✓</span> : <span>{formatZar(b - a, { cents: false })}</span>);
  return (
    <div className="stack-lg narrow-wide">
      <div className="banner ok">
        Imported {r.counts.projects} jobs, {r.counts.invoices} invoices, {r.counts.costs} costs, {r.counts.labour} labour days and {r.counts.wagePayments} wage payments for {r.counts.workers} workers.
      </div>
      <section className="panel panel-pad stack">
        <h3>Checked against your sheets</h3>
        <p className="small">
          <strong>Per Project:</strong> {r.jobsChecked} jobs checked, {r.jobDifferences.length ? `${r.jobDifferences.length} differ` : 'every job’s labour and parts agree'} (to within a rand of rounding).
        </p>
        {r.jobDifferences.length > 0 && (
          <ul className="small">
            {r.jobDifferences.map((j) => (
              <li key={j.name + j.field}>
                {j.name} {j.field}: sheet {formatZar(j.sheetCents)}, Shap {formatZar(j.shapCents)}
              </li>
            ))}
          </ul>
        )}
        {r.checks.length > 0 && (
          <>
            <p className="small">
              <strong>Trade Statement</strong>, all months together: invoiced {cell(sum('invoicedCents', 'sheet'), sum('invoicedCents', 'shap'))}, parts{' '}
              {cell(sum('partsCents', 'sheet'), sum('partsCents', 'shap'))}, labour {cell(sum('labourCents', 'sheet'), sum('labourCents', 'shap'))}.
              {off.length > 0 && ' Months can differ where a slip or a day was dated after the job’s invoice: Shap counts it in the month it happened, the pivot in the invoice month.'}
            </p>
            {off.length > 0 && (
              <details>
                <summary className="small">Month by month (Shap minus sheet)</summary>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th className="num">Invoiced</th>
                        <th className="num">Parts</th>
                        <th className="num">Labour</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.checks.map((c) => (
                        <tr key={c.month}>
                          <td>{monthLabel(c.month)}</td>
                          <td className="num">{cell(c.sheet.invoicedCents, c.shap.invoicedCents)}</td>
                          <td className="num">{cell(c.sheet.partsCents, c.shap.partsCents)}</td>
                          <td className="num">{cell(c.sheet.labourCents, c.shap.labourCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>
        )}
      </section>
      {r.agreement && (
        <section className="panel panel-pad stack">
          <h3>Year end {formatDate(r.agreement.date)}</h3>
          <p className="small">{r.agreement.note}</p>
          <table className="table">
            <tbody>
              {r.agreement.lines.map((l) => (
                <tr key={l.account}>
                  <td>{l.account}</td>
                  <td className="num">{l.amountCents > 0 ? `Dr ${formatZar(l.amountCents)}` : `Cr ${formatZar(-l.amountCents)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <section className="panel panel-pad stack">
        <h3>How the “Account” column was read</h3>
        <table className="table">
          <tbody>
            {r.sourceMapping.map((m) => (
              <tr key={m.account}>
                <td>{m.account}</td>
                <td>{m.source}</td>
                <td className="muted">{m.postsTo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel panel-pad stack">
        <h3>Next</h3>
        <ol className="small next-steps">
          <li>If you have a company file, load it below: trading names, logos, bank details, clients and agreed year ends in one go. Otherwise set up Settings → Company → Trading names.</li>
          <li>Import your client list from Invoice Ninja (Clients → Import details) to swap codes for real names and emails.</li>
          {r.counts.uncapturedCosts ? <li>Say how the {r.counts.uncapturedCosts} costs with a blank account were paid (Costs → Not captured yet).</li> : null}
          <li>Enter your accountant’s figures for past years under Accounts → Year end, so the books start where the statements end.</li>
          <li>{r.counts.unallocatedLabour ? `Allocate the ${r.counts.unallocatedLabour} labour days that had no job (Workers → Allocate).` : 'All labour is on a job.'}</li>
          <li>Under Accounts → Balance checks, enter today’s bank balance and your loan balance; one tap posts the money that moved between them.</li>
        </ol>
        {r.warnings.length > 0 && (
          <details>
            <summary className="small">Notes from the import ({r.warnings.length})</summary>
            <ul className="small">
              {r.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

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
              {b.logoId ? <img src={apiUrl(`/api/attachments/${b.logoId}`)} alt="" className="brand-logo" /> : <span className="brand-logo empty">No logo</span>}
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
    logoLayout: brand?.logoLayout ?? {},
  });
  const [logoId, setLogoId] = useState(brand?.logoId ?? null);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f, v: string | boolean | Brand['logoLayout']) => setF((x) => ({ ...x, [k]: v }));
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
      const img = file.type === 'image/png' ? { dataBase64: await fileToBase64(file), mime: 'image/png' as const, filename: file.name } : await shrinkImage(file, 1200, 0.9);
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
            <div className="stack">
              {logoId && <LogoPlacer path={`/api/attachments/${logoId}`} layout={f.logoLayout ?? {}} onChange={(l) => set('logoLayout', l)} accent={f.accent} />}
              <div className="row wrap">
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

/* ---------------------------------------------------------------- company file */
function CompanyFile() {
  const { refreshReference } = useAuthed();
  const [passwordPrompt, askPassword] = usePasswordPrompt();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState('');
  const load = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const json = JSON.parse(await file.text());
      const password = await askPassword('Load a company file', 'Loading a company file changes your setup. Enter your password to go ahead.');
      if (!password) return;
      const r = await api<{ restored: Record<string, number> }>('/api/company-file', { body: { file: json, password } });
      setResult(r.restored);
      await refreshReference();
      toast('Company file loaded');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof SyntaxError ? 'That isn’t a Shap company file' : 'Couldn’t load that file');
    } finally {
      setBusy(false);
    }
  };
  const labels: Record<string, string> = { brands: 'trading names', clients: 'clients', jobsLinked: 'jobs linked to a client', jobsBranded: 'jobs given a trading name', yearEnds: 'agreed year ends' };
  return (
    <section className="panel panel-pad stack narrow-wide">
      <h3>Company file</h3>
      <p className="small">
        Everything that sets Shap up, without the day-to-day records: trading names and logos, company details, numbering and terms, your lists and
        accounts, clients, and the accountant’s agreed year ends. Save one to keep a copy or move to another server. Loading one merges it in; nothing is
        deleted. Load it <strong>after</strong> importing the tracker, so it can link jobs to clients.
      </p>
      <div className="row wrap">
        <button
          className="btn"
          onClick={async () => {
            const password = await askPassword('Save the company file', 'Enter your password to download your company file.');
            if (!password) return;
            try {
              const r = await api<{ url: string }>('/api/company-file/link', { body: { password } });
              window.location.assign(apiUrl(r.url));
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'Couldn’t download it');
            }
          }}
        >
          <Icon name="download" size={18} />
          Save company file
        </button>
        {passwordPrompt}
        <label className="btn primary">
          <Icon name="upload" size={18} />
          {busy ? 'Loading…' : 'Load a company file'}
          <input type="file" accept=".json,application/json" hidden onChange={(e) => void load(e.target.files?.[0])} disabled={busy} />
        </label>
      </div>
      {error && <div className="banner alert small">{error}</div>}
      {result && (
        <div className="banner ok small">
          Loaded: {Object.entries(result).map(([k, v]) => `${v} ${labels[k] ?? k}`).join(', ') || 'settings'}.
        </div>
      )}
    </section>
  );
}

/** Not registered for VAT: how close the last 12 months are to the point where you must. */
function VatThreshold() {
  const { data } = useApi<{ last12Cents: number; pace12Cents: number; compulsoryCents: number; voluntaryCents: number; state: 'over' | 'near' | 'voluntary' | null }>('/api/vat/threshold');
  if (!data) return null;
  const pct = Math.min(100, Math.round((data.last12Cents / data.compulsoryCents) * 100));
  return (
    <div className={`banner small${data.state === 'over' || data.state === 'near' ? ' alert' : ''}`}>
      <strong>{formatZar(data.last12Cents)}</strong> of income in the last 12 months ({pct}% of the {formatZar(data.compulsoryCents)} at which VAT registration is
      compulsory).{' '}
      {data.state === 'over'
        ? 'That’s over the line: you must register with SARS within 21 days of passing it.'
        : data.state === 'near'
          ? `Getting close${data.pace12Cents > data.compulsoryCents ? `: the last three months are running at ${formatZar(data.pace12Cents)} a year` : ''}. Talk to your accountant about registering before you pass it.`
          : data.state === 'voluntary'
            ? `You may register voluntarily (from ${formatZar(data.voluntaryCents)}), but you don’t have to yet.`
            : 'Nothing to do yet.'}{' '}
      <span className="muted">Shap counts all income in the books, so exempt income (interest, residential rent) makes this a little high.</span>
    </div>
  );
}


/**
 * A form's own fields: the switches and preferences (saved on the What you use tab) are left out,
 * so a form opened before one of them changed doesn't put it back.
 */
function formOnly(f: Settings): Partial<Settings> {
  const { features: _f, tone: _t, industry: _i, usageConsent: _u, sdl: _s, watermark: _w, ...mine } = f;
  return mine;
}

/** Saves settings: everything as it is, with these changes. */
async function saveSettings(settings: Settings, changes: Partial<Settings>) {
  const { logoId: _l, ...rest } = { ...settings, ...changes } as Settings & { logoId: string | null };
  await api('/api/settings', { method: 'PUT', body: { ...rest, lockDate: rest.lockDate ?? null } });
}

/** One name on the door (trading names off): how the business appears on its quotes and invoices. */
function BusinessDetails() {
  const { settings, refreshReference } = useAuthed();
  const toast = useToast();
  const [f, setF] = useState<Settings>({ ...settings });
  const [logoId, setLogoId] = useState(settings.logoId);
  const [error, setError] = useState('');
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await saveSettings(settings, formOnly(f));
      await refreshReference();
      toast('Saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  const text = (k: 'tradingName' | 'phone' | 'email' | 'website', label: string, type = 'text') => (
    <Field label={label}>{(p) => <input {...p} className="input" type={type} value={f[k]} onChange={(e) => set(k, e.target.value)} />}</Field>
  );
  return (
    <form className="stack-lg narrow-wide" onSubmit={save}>
      <section className="panel panel-pad stack">
        <h3>On your quotes and invoices</h3>
        <p className="xs muted">Several names on the door? Switch on “More than one trading name” under What you use.</p>
        <div className="form-grid">
          {text('tradingName', 'Trading as (optional)')}
          {text('phone', 'Phone', 'tel')}
          {text('email', 'Email', 'email')}
          {text('website', 'Website')}
        </div>
        <Field label="Address">{(p) => <textarea {...p} className="textarea" rows={3} value={f.address} onChange={(e) => set('address', e.target.value)} />}</Field>
        <Field label="Bank details" hint="Printed on invoices">{(p) => <textarea {...p} className="textarea" rows={3} value={f.bankDetails} onChange={(e) => set('bankDetails', e.target.value)} />}</Field>
        <Field label="Colour" hint="Headings and the amount-due box on the PDF">
          {(p) => (
            <div className="row">
              <input {...p} type="color" value={f.accent} onChange={(e) => set('accent', e.target.value)} className="color-input" />
              <input className="input" value={f.accent} onChange={(e) => set('accent', e.target.value)} style={{ maxWidth: 120 }} aria-label="Colour code" />
            </div>
          )}
        </Field>
      </section>
      <section className="panel panel-pad stack">
        <h3>Logo</h3>
        <LogoField logoId={logoId} layout={f.logoLayout ?? {}} accent={f.accent} onLogo={(id) => (setLogoId(id), void refreshReference())} onLayout={(l) => set('logoLayout', l)} />
      </section>
      {error && <div className="banner alert small">{error}</div>}
      <button className="btn primary big block">Save</button>
    </form>
  );
}

/** Switch parts of the app off that a business like yours doesn't need; how Shap talks; what it may share. */
function Sections() {
  const { settings, refreshReference } = useAuthed();
  const toast = useToast();
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(FEATURE_KEYS.map((k) => [k, featureOn(settings.features, k)])));
  const [prefs, setPrefs] = useState({ tone: settings.tone, industry: settings.industry, usageConsent: settings.usageConsent, sdl: settings.sdl, watermark: settings.watermark });
  const save = async (changes: Partial<Settings>, done: string) => {
    try {
      await saveSettings(settings, changes);
      await refreshReference();
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
              {g.keys.filter((k) => k !== 'dividends' || settings.businessType === 'company').map((k) => (
                <li key={k} className="list-row">
                  <label className="check grow">
                    <input type="checkbox" checked={on[k]} onChange={(e) => void toggle(k, e.target.checked)} />
                    <span>
                      {FEATURES[k].label}
                      <div className="xs muted">{FEATURES[k].hint}</div>
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
                      <div className="xs muted">When your payroll is over R500 000 a year: 1% of salaries, paid by you.</div>
                    </span>
                  </label>
                </li>
              )}
            </ul>
          </div>
        ))}
        {(on.payshap || on.proformas || on.creditNotes) && (
          <p className="xs muted panel-pad" style={{ paddingTop: 0 }}>
            Numbering for credit notes and pro-formas, and your ShapID, are under <Link to="/settings?tab=invoicing">Invoicing &amp; books</Link>.
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
            <div className="xs muted">Only the kind of business and which parts are switched on. Never names, clients or figures.</div>
          </span>
        </label>
      </section>
      <SupportShap />
    </div>
  );
}
