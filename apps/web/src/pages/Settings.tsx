import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  ROLES,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  type AccountType,
  type CategoryKind,
  type Role,
  type SourceKind,
} from '@shap/shared';
import { PageHead } from '../components/Shell';
import { Drawer, ErrorBox, Field, Icon, Loading, Tabs, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { fileToBase64, shrinkImage } from '../lib/files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { Brand, Settings } from '../lib/types';
import { BusinessFields, LogoField } from '../components/BusinessForm';
import { ApiImage } from '../components/Files';
import { FEATURES, FEATURE_KEYS, featureOn } from '@shap/shared';

type Tab = 'business' | 'invoicing' | 'sections' | 'lists';
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
          ]}
        />
      </div>
      {tab === 'business' && (
        <>
          <BusinessSettings />
          {has('brands') && <TradingNames />}
        </>
      )}
      {tab === 'invoicing' && <SettingsForm section="invoicing" />}
      {tab === 'sections' && <Sections />}
      {tab === 'lists' && <Lists />}
    </div>
  );
}

/** Saves settings: everything as it is, with these changes. */
async function saveSettings(settings: Settings, changes: Partial<Settings>) {
  const { logoId: _l, ...rest } = { ...settings, ...changes } as Settings & { logoId: string | null };
  await api('/api/settings', { method: 'PUT', body: rest });
}

function BusinessSettings() {
  const { settings, refreshReference } = useAuthed();
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
      await saveSettings(settings, { ...f, fyEndMonth: f.businessType === 'sole_prop' ? 2 : f.fyEndMonth });
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

/** Switch parts of the app off that a business like yours doesn't need. */
function Sections() {
  const { settings, refreshReference } = useAuthed();
  const toast = useToast();
  const toggle = async (k: (typeof FEATURE_KEYS)[number], on: boolean) => {
    try {
      await saveSettings(settings, { features: { ...settings.features, [k]: on } });
      await refreshReference();
      toast(`${FEATURES[k].label} ${on ? 'on' : 'off'}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save', 'error');
    }
  };
  return (
    <section className="panel narrow-wide">
      <div className="panel-head">
        <strong>What you use</strong>
        <div className="xs muted">Switch off what a business like yours doesn’t need. Nothing is deleted: switch it on again and it’s all still there.</div>
      </div>
      <ul className="list">
        {FEATURE_KEYS.map((k) => (
          <li key={k} className="list-row">
            <label className="check grow">
              <input type="checkbox" checked={featureOn(settings.features, k)} onChange={(e) => void toggle(k, e.target.checked)} />
              <span>
                {FEATURES[k].label}
                <div className="xs muted">{FEATURES[k].hint}</div>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SettingsForm({ section }: { section: 'company' | 'invoicing' }) {
  const { settings, ref, refreshReference } = useAuthed();
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
      const { logoId: _l, ...rest } = f as Settings & { logoId: string | null };
      await api('/api/settings', { method: 'PUT', body: rest });
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
            <p className="xs muted">
              Next invoice: <strong>{`${f.invoicePrefix}${String(f.invoiceNext).padStart(f.invoicePad, '0')}`}</strong> · next quote:{' '}
              <strong>{`${f.quotePrefix}${String(f.quoteNext).padStart(f.quotePad, '0')}`}</strong>
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
