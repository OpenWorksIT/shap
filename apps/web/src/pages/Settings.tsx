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
import { api, ApiError, apiUrl } from '../lib/api';
import { fileToBase64, shrinkImage } from '../lib/files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { Settings } from '../lib/types';

type Tab = 'company' | 'invoicing' | 'lists' | 'users' | 'import';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'company';
  return (
    <div className="stack-lg">
      <PageHead title="Settings" />
      <div className="tabs-scroll">
        <Tabs<Tab>
          value={tab}
          onChange={(t) => setParams({ tab: t }, { replace: true })}
          tabs={[
            { value: 'company', label: 'Company' },
            { value: 'invoicing', label: 'Invoicing & books' },
            { value: 'lists', label: 'Lists' },
            { value: 'users', label: 'People who sign in' },
            { value: 'import', label: 'Import tracker' },
          ]}
        />
      </div>
      {tab === 'company' && <SettingsForm section="company" />}
      {tab === 'invoicing' && <SettingsForm section="invoicing" />}
      {tab === 'lists' && <Lists />}
      {tab === 'users' && <Users />}
      {tab === 'import' && <ImportTracker />}
    </div>
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
      const { logoId: _l, ...rest } = f;
      await api('/api/settings', { method: 'PUT', body: rest });
      await refreshReference();
      toast('Settings saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };
  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    try {
      const img = file.type === 'image/png' ? { dataBase64: await fileToBase64(file), mime: 'image/png' as const, filename: file.name } : await shrinkImage(file, 800, 0.9);
      await api('/api/settings/logo', { body: img });
      await refreshReference();
      toast('Logo saved. It appears on quotes and invoices.');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t upload the logo', 'error');
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
            <h3>Company</h3>
            <div className="form-grid">
              {text('companyName', 'Registered name', 'e.g. Construction Solutions (Pty) Ltd')}
              {text('tradingName', 'Trading as', 'Shown big on quotes and invoices, if different')}
              {text('regNumber', 'Registration number')}
              {text('vatNumber', 'VAT number')}
              {text('phone', 'Phone', undefined, 'tel')}
              {text('email', 'Email', 'Replies to emailed invoices go here', 'email')}
              {text('website', 'Website')}
            </div>
            <Field label="Address">{(p) => <textarea {...p} className="textarea" rows={3} value={f.address} onChange={(e) => set('address', e.target.value)} />}</Field>
          </section>
          <section className="panel panel-pad stack">
            <h3>Banking details (printed on invoices)</h3>
            <Field label="Bank, account and branch">{(p) => <textarea {...p} className="textarea" rows={3} value={f.bankDetails} onChange={(e) => set('bankDetails', e.target.value)} placeholder={'FNB · Gold Business account\nAccount 62xxxxxxxxx · Branch 250655'} />}</Field>
          </section>
          <section className="panel panel-pad stack">
            <h3>Logo</h3>
            <div className="row wrap">
              {settings.logoId && <img src={apiUrl(`/api/attachments/${settings.logoId}`)} alt="Company logo" className="logo-preview" />}
              <label className="btn">
                <Icon name="upload" size={18} />
                {settings.logoId ? 'Replace logo' : 'Upload a logo'}
                <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => void uploadLogo(e.target.files?.[0])} />
              </label>
              {settings.logoId && (
                <button type="button" className="btn quiet" onClick={() => void api('/api/settings/logo', { method: 'DELETE' }).then(refreshReference)}>
                  Remove
                </button>
              )}
            </div>
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
            <h3>VAT and the financial year</h3>
            <label className="check">
              <input type="checkbox" checked={f.vatRegistered} onChange={(e) => set('vatRegistered', e.target.checked)} />
              <span>
                Registered for VAT
                <div className="xs muted">New invoices add VAT and say “Tax invoice”; costs can record the VAT you claim back. Existing invoices keep what they had.</div>
              </span>
            </label>
            <div className="form-grid">
              {f.vatRegistered && <Field label="VAT rate (%)">{(p) => <input {...p} className="input" type="number" step="0.5" value={f.vatRateBp / 100} onChange={(e) => set('vatRateBp', Math.round(Number(e.target.value) * 100))} />}</Field>}
              <Field label="Financial year ends in">
                {(p) => (
                  <select {...p} className="select" value={f.fyEndMonth} onChange={(e) => set('fyEndMonth', Number(e.target.value))}>
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
  const { ref, refreshReference } = useAuthed();
  const [edit, setEdit] = useState<{ kind: ListKind; row: Record<string, unknown> | null } | null>(null);
  const acc = (id: string) => ref.accounts.find((a) => a.id === id);
  return (
    <div className="stack-lg">
      <section className="panel">
        <div className="panel-head spread">
          <span>
            <strong>Paid from / paid into</strong>
            <div className="xs muted">Your bank account, each card, cash. Each one says which account in the books it belongs to: cards in your own name go to your loan account.</div>
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
    const body = kind === 'sources' ? { name: f.name, kind: f.kind, accountId: f.accountId, active: f.active } : kind === 'categories' ? { name: f.name, kind: f.kind, accountId: f.accountId, active: f.active } : kind === 'accounts' ? { code: f.code, name: f.name, type: f.type, active: f.active } : { name: f.name, active: f.active };
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
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', role: (user?.role ?? 'capture') as Role, password: '', active: user?.active ?? true });
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...f, password: f.password || undefined };
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
        <Field label={user ? 'New password (leave blank to keep)' : 'Starting password'} hint="At least 10 characters. Tell them to change it.">
          {(p) => <input {...p} className="input" type="text" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required={!user} minLength={user ? undefined : 10} />}
        </Field>
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
            <button type="button" className="btn" onClick={() => void api(`/api/users/${user.id}/reset-mfa`, { body: {} }).then(() => (toast('Two-factor reset; they set it up again at next sign-in'), onSaved()))}>
              Reset two-factor (lost phone)
            </button>
          )}
        </div>
      </form>
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
  const [opts, setOpts] = useState({ replace: false, agreeTrialBalance: true, blankAccountTo: 'bank' as 'bank' | 'owner_loan' });
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
            <h3>Two choices</h3>
            <div className="field">
              <span className="label">Costs with a blank “Account” were paid from…</span>
              <label className="check">
                <input type="radio" checked={opts.blankAccountTo === 'bank'} onChange={() => setOpts({ ...opts, blankAccountTo: 'bank' })} />
                The company’s bank account
              </label>
              <label className="check">
                <input type="radio" checked={opts.blankAccountTo === 'owner_loan'} onChange={() => setOpts({ ...opts, blankAccountTo: 'owner_loan' })} />
                My own money (adds to my loan account)
              </label>
              <span className="hint">You can change this afterwards under Lists → “Not recorded (tracker)”, and the books follow.</span>
            </div>
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
          <li>Fill in Settings → Company and your banking details, so quotes and invoices are ready to send.</li>
          <li>Import your client list from Invoice Ninja (Clients → Import details) to swap codes for real names and emails.</li>
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
