/**
 * Your business as clients see it on quotes and invoices: name, contacts, bank details, colour
 * and logo. Used by the first-run questions and by Settings.
 */
import { useState } from 'react';
import { BUSINESS_TYPES, ENTITIES, entity, regNumberProblem, taxNumberProblem, vatNumberProblem } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { cleanPngLogo, shrinkImage } from '../lib/files';
import { pickFile } from '../lib/native';
import type { Settings } from '../lib/types';
import { LogoPlacer } from './LogoPlacer';
import { Field, Icon, useToast } from './ui';

export type BusinessFields = Pick<
  Settings,
  'companyName' | 'tradingName' | 'businessType' | 'regNumber' | 'vatRegistered' | 'vatNumber' | 'taxNumber' | 'address' | 'phone' | 'email' | 'website' | 'bankDetails' | 'accent' | 'logoLayout'
>;

export function BusinessFields({ f, set, compact = false }: { f: BusinessFields; set: <K extends keyof BusinessFields>(k: K, v: BusinessFields[K]) => void; compact?: boolean }) {
  const text = (k: 'companyName' | 'tradingName' | 'regNumber' | 'vatNumber' | 'taxNumber' | 'phone' | 'email' | 'website', label: string, hint?: string, type = 'text', required = false, error?: string | null, placeholder?: string) => (
    <Field label={label} hint={hint} error={error ?? undefined}>
      {(p) => <input {...p} className="input" type={type} value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} required={required} placeholder={placeholder} />}
    </Field>
  );
  const kind = entity(f.businessType);
  const registered = kind.key !== 'sole_prop' && kind.key !== 'partnership';
  return (
    <div className="stack">
      <Field label="Your business is" hint={compact ? undefined : `${kind.description} ${kind.ownerMoney}`}>
        {(p) => (
          <select {...p} className="select" value={f.businessType} onChange={(e) => set('businessType', e.target.value as BusinessFields['businessType'])}>
            {BUSINESS_TYPES.map((t) => (
              <option key={t} value={t}>
                {ENTITIES[t].label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="form-grid">
        {text('companyName', registered ? 'Registered name' : 'Business name', kind.example, 'text', true)}
        {text('tradingName', 'Trading as (optional)', 'Only if quotes should show a different name')}
        {kind.regLabel && text('regNumber', kind.regLabel, kind.regHint, 'text', false, regNumberProblem(f.regNumber, f.businessType), kind.regPlaceholder)}
      </div>
      <label className="check">
        <input type="checkbox" checked={f.vatRegistered} onChange={(e) => set('vatRegistered', e.target.checked)} />
        <span>
          Registered for VAT
          <div className="xs muted">Invoices add VAT and say “Tax invoice”. Not registered? Shap watches your income over any 12 months in a row and warns you as it nears the point where you must.</div>
        </span>
      </label>
      <div className="form-grid">
        {f.vatRegistered && text('vatNumber', 'VAT number', '10 digits starting with 4, on your VAT registration letter', 'text', false, f.vatNumber.trim() ? vatNumberProblem(f.vatNumber) : 'Needed while registered for VAT')}
        {!compact && text('taxNumber', 'Income tax number', 'The business’s own, 10 digits (for a sole proprietor, yours)', 'text', false, taxNumberProblem(f.taxNumber ?? ''))}
      </div>
      <div className="form-grid">
        {text('phone', 'Phone', undefined, 'tel')}
        {text('email', 'Email', undefined, 'email')}
        {!compact && text('website', 'Website')}
      </div>
      <Field label="Address" hint="On your quotes and invoices">
        {(p) => <textarea {...p} className="textarea" rows={3} value={f.address} onChange={(e) => set('address', e.target.value)} />}
      </Field>
      <Field label="Bank details" hint="Printed on invoices so clients can pay you">
        {(p) => <textarea {...p} className="textarea" rows={3} value={f.bankDetails} onChange={(e) => set('bankDetails', e.target.value)} placeholder={'Capitec · Savings\nAccount 1234567890 · Branch 470010'} />}
      </Field>
      <Field label="Colour" hint="Headings and the amount-due box on your PDFs">
        {(p) => (
          <div className="row">
            <input {...p} type="color" value={f.accent} onChange={(e) => set('accent', e.target.value)} className="color-input" />
            <input className="input" value={f.accent} onChange={(e) => set('accent', e.target.value)} style={{ maxWidth: 120 }} aria-label="Colour code" />
          </div>
        )}
      </Field>
    </div>
  );
}

/** Your logo: add it from photos or files, then place it. Changes to the placing are saved with the form. */
export function LogoField({ logoId, layout, accent, onLogo, onLayout }: { logoId: string | null; layout: BusinessFields['logoLayout']; accent: string; onLogo: (id: string | null) => void; onLayout: (l: BusinessFields['logoLayout']) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const file = await pickFile(['image/png', 'image/jpeg']);
    if (!file) return;
    setBusy(true);
    try {
      const img = file.type === 'image/png' ? await cleanPngLogo(file) : await shrinkImage(file, 1200, 0.9);
      const r = await api<{ logoId: string }>('/api/settings/logo', { body: img });
      onLogo(r.logoId);
      onLayout({ zoom: 1, x: 0, y: 0 });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t add the logo', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {logoId ? <LogoPlacer path={`/api/attachments/${logoId}`} layout={layout} onChange={onLayout} accent={accent} /> : <p className="xs muted">No logo yet: your business name is printed in its place. A PNG with a see-through background looks best.</p>}
      <div className="row wrap">
        <button type="button" className="btn" onClick={() => void add()} disabled={busy}>
          <Icon name="upload" size={18} />
          {logoId ? 'Change logo' : 'Add your logo'}
        </button>
        {logoId && (
          <button type="button" className="btn quiet" onClick={() => void api('/api/settings/logo', { method: 'DELETE' }).then(() => onLogo(null))}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
