/**
 * The audit log: every change, sign-in and export, who did it and when. It can't be changed or
 * deleted from the app, and it's part of every backup, so the history goes wherever the books go.
 */
import { useEffect, useState } from 'react';
import { formatZar } from '@shap/shared';
import { api, ApiError, apiBlob } from '../lib/api';
import { shareFile } from '../lib/native';
import { Field, Loading } from './ui';

interface Entry {
  id: number;
  at: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: Record<string, unknown>;
  userName: string | null;
  actor: string;
}

const RECORDS: Record<string, string> = {
  invoice: 'Invoice',
  quote: 'Quote',
  credit_note: 'Credit note',
  cost: 'Cost',
  client: 'Client',
  project: 'Job',
  labour: 'Labour',
  worker: 'Worker',
  employee: 'Employee',
  pay_run: 'Pay run',
  receipt: 'Payment received',
  journal: 'Journal',
  asset: 'Asset',
  dividend: 'Dividend',
  settings: 'Settings',
  user: 'Sign-in and people',
  system: 'Updates and backups',
  bank_statement: 'Bank statement',
  bank_line: 'Bank line',
  statement_file: 'Statement file',
  year_end: 'Year end',
  brand: 'Trading name',
  partner: 'Partner',
  profit_share: 'Profit share',
  wage_payment: 'Wage payment',
  sars_payment: 'Payment to SARS',
  tax_estimate: 'Tax estimate',
  balance_check: 'Balance check',
  company: 'Company',
  books: 'Books',
  audit_log: 'Audit log',
  attachment: 'Attachment',
};
const ACTIONS: Record<string, string> = {
  create: 'added',
  update: 'changed',
  delete: 'deleted',
  issue: 'issued',
  void: 'voided',
  convert: 'turned into an invoice',
  login: 'signed in',
  login_failed: 'sign-in failed',
  password_failed: 'wrong password',
  password_changed: 'password changed',
  mfa_enabled: 'two-factor switched on',
  mfa_disabled: 'two-factor switched off',
  mfa_failed: 'two-factor code wrong',
  mfa_reset: 'two-factor reset',
  mfa_recovery_codes: 'new recovery codes',
  accept_terms: 'terms of use accepted',
  export: 'exported',
  download_backup: 'backup downloaded',
  write_off: 'written off',
  undo_write_off: 'write-off undone',
  finalise: 'finalised',
  reopen: 'reopened',
  agree_year_end: 'year end agreed',
  remove_year_end: 'year end removed',
  wipe_all_data: 'everything wiped',
  restore_company_file: 'company file loaded',
};
export const recordName = (e: string) => RECORDS[e] ?? e.replace(/_/g, ' ');
const actionName = (a: string) => ACTIONS[a] ?? a.replace(/_/g, ' ');
/** Actions that say it all on their own ("Signed in", not "Sign-in and people signed in"). */
const ALONE: Record<string, string> = {
  login: 'Signed in',
  login_failed: 'Sign-in failed',
  password_failed: 'Wrong password entered',
  password_changed: 'Password changed',
  mfa_enabled: 'Two-factor sign-in switched on',
  mfa_disabled: 'Two-factor sign-in switched off',
  mfa_failed: 'Wrong two-factor code',
  mfa_reset: 'Two-factor sign-in reset',
  mfa_recovery_codes: 'New recovery codes made',
  accept_terms: 'Terms of use accepted',
  download_backup: 'Backup downloaded',
  wipe_all_data: 'Everything wiped',
  restore_company_file: 'Company file loaded',
  show_demo: 'Demo company shown',
  leave_demo: 'Back from the demo company',
  system_check: 'Asked to check for updates',
  system_update: 'Asked to update',
  system_backup: 'Asked for a backup',
};
const describe = (entity: string, action: string) => ALONE[action] ?? `${recordName(entity)} ${actionName(action)}`;

/** The few details worth reading in a row; the rest are in the export. */
function detailText(d: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof d.number === 'string') bits.push(d.number);
  if (typeof d.client === 'string' && d.client) bits.push(d.client);
  if (typeof d.issueDate === 'string') bits.push(d.issueDate);
  if (typeof d.totalCents === 'number') bits.push(formatZar(d.totalCents));
  if (typeof d.version === 'string') bits.push(`version ${d.version}`);
  if (typeof d.name === 'string') bits.push(d.name);
  if (typeof d.reason === 'string' && d.reason) bits.push(d.reason);
  if (!bits.length) {
    const keys = Object.keys(d).filter((k) => !['ip', 'url'].includes(k));
    if (keys.length) bits.push(keys.slice(0, 4).map((k) => `${k}: ${typeof d[k] === 'object' ? '…' : String(d[k])}`).join(', '));
  }
  return bits.join(' · ');
}

export function AuditLog() {
  const [items, setItems] = useState<Entry[]>([]);
  const [entities, setEntities] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [entity, setEntity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const query = (before?: number) => new URLSearchParams({ ...(entity ? { entity } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(before ? { before: String(before) } : {}) }).toString();
  const load = async (before?: number) => {
    setLoading(true);
    try {
      const r = await api<{ items: Entry[]; more: boolean; entities: string[] }>(`/api/audit?${query(before)}`);
      setItems((x) => (before ? [...x, ...r.items] : r.items));
      setMore(r.more);
      setEntities(r.entities);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t load the audit log');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, from, to]);

  return (
    <section className="panel stack-lg narrow-wide">
      <div className="panel-head stack" style={{ gap: 4 }}>
        <strong>Audit log</strong>
        <span className="xs muted">
          Every change, sign-in and export: who, what and when. It can’t be changed or deleted from the app, and it’s in every backup, so your history goes wherever the books go. SARS may ask to see how a
          record changed.
        </span>
      </div>
      <div className="panel-pad stack" style={{ paddingTop: 0 }}>
        <div className="form-grid">
          <Field label="Show">
            {(p) => (
              <select {...p} className="select" value={entity} onChange={(e) => setEntity(e.target.value)}>
                <option value="">Everything</option>
                {entities.map((e) => (
                  <option key={e} value={e}>
                    {recordName(e)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="From">{(p) => <input {...p} className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="To">{(p) => <input {...p} className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
        <div>
          <button
            type="button"
            className="btn small"
            onClick={() =>
              void apiBlob(`/api/audit.csv?${query()}`)
                .then(({ blob }) => shareFile(blob, 'shap-audit-log.csv', 'Audit log'))
                .catch((err: Error) => setError(err.message))
            }
          >
            Save as a spreadsheet (CSV)
          </button>
        </div>
        {error && <div className="banner alert small">{error}</div>}
        <ul className="list audit-list">
          {items.map((r) => (
            <li key={r.id} className="list-row">
              <span className="grow">
                <strong className="small">{describe(r.entity, r.action)}</strong>
                <div className="xs muted">
                  {new Date(r.at).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })} · {r.userName ?? (r.actor === 'system' ? 'Shap' : r.actor)}
                  {detailText(r.details ?? {}) ? ` · ${detailText(r.details ?? {})}` : ''}
                </div>
              </span>
            </li>
          ))}
          {!items.length && !loading && <li className="list-row muted small">Nothing here for those dates.</li>}
        </ul>
        {loading && <Loading />}
        {more && !loading && (
          <button type="button" className="btn quiet" onClick={() => void load(items.at(-1)?.id)}>
            Show older
          </button>
        )}
      </div>
    </section>
  );
}
