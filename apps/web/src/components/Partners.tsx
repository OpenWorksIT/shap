/**
 * A partnership's partners (server: modules/partners.ts): who they are, their share of profit
 * and loss, and what's in their capital and current accounts.
 */
import { useState, type FormEvent } from 'react';
import { formatZar } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { Drawer, Field, Icon, Loading, useToast } from './ui';

export interface Partner {
  id: string;
  name: string;
  shareBp: number;
  active: boolean;
  capitalCents: number;
  currentCents: number;
}

const pct = (bp: number) => `${(bp / 100).toLocaleString('en-ZA', { maximumFractionDigits: 2 })}%`;

export function Partners() {
  const { settings, isOwner } = useAuthed();
  const list = useApi<{ partners: Partner[] }>(settings.businessType === 'partnership' ? '/api/partners' : null);
  const [editing, setEditing] = useState<Partner | 'new' | null>(null);
  if (settings.businessType !== 'partnership') return null;
  const partners = list.data?.partners ?? [];
  const active = partners.filter((p) => p.active);
  const total = active.reduce((t, p) => t + p.shareBp, 0);
  return (
    <section className="panel panel-pad stack">
      <div className="row spread">
        <h3>Partners</h3>
        {isOwner && (
          <button type="button" className="btn small" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} />
            Add a partner
          </button>
        )}
      </div>
      <p className="xs muted">
        Each partner has a capital account (what they put in) and a current account (their share of each year’s profit, less what they take out), and their own “Paid personally” to choose when they pay for something themselves. The year’s profit is shared by these shares at the year end.
      </p>
      {!list.data ? (
        <Loading />
      ) : !partners.length ? (
        <p className="small muted">No partners yet. Add each partner and their share of the profit.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Partner</th>
                <th className="num">Share</th>
                <th className="num hide-sm">Capital</th>
                <th className="num">Current account</th>
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => (
                <tr key={p.id} className={p.active ? undefined : 'muted'} onClick={isOwner ? () => setEditing(p) : undefined} style={isOwner ? { cursor: 'pointer' } : undefined}>
                  <td>
                    {p.name}
                    {!p.active && <span className="xs muted"> (left)</span>}
                  </td>
                  <td className="num">{pct(p.shareBp)}</td>
                  <td className="num hide-sm">{formatZar(p.capitalCents)}</td>
                  <td className="num">{formatZar(p.currentCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {active.length > 0 && total !== 10000 && <div className="banner signal small">The partners’ shares add up to {pct(total)}. They need to add up to 100% before a year’s profit can be shared.</div>}
      {editing && <PartnerDrawer partner={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await list.reload(); }} />}
    </section>
  );
}

function PartnerDrawer({ partner, onClose, onSaved }: { partner: Partner | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState(partner?.name ?? '');
  const [share, setShare] = useState(partner ? String(partner.shareBp / 100) : '');
  const [active, setActive] = useState(partner?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const shareBp = Math.round(Number(share.replace(',', '.')) * 100);
    if (!Number.isFinite(shareBp) || shareBp < 0 || shareBp > 10000) return setError('Give a share between 0% and 100%');
    setBusy(true);
    setError('');
    try {
      const body = { name, shareBp, active };
      if (partner) await api(`/api/partners/${partner.id}`, { method: 'PUT', body });
      else await api('/api/partners', { body });
      toast(partner ? 'Partner saved' : 'Partner added, with their own capital and current accounts');
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer title={partner ? partner.name : 'Add a partner'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <Field label="Name">{(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        <Field label="Share of profit and loss (%)" hint="As agreed between the partners. All the partners’ shares add up to 100%.">
          {(p) => <input {...p} className="input" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="e.g. 50" />}
        </Field>
        {partner && (
          <label className="check">
            <input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} />
            <span>
              Has left the partnership
              <div className="xs muted">Their accounts stay in the books; they’re left out of new profit shares.</div>
            </span>
          </label>
        )}
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </Drawer>
  );
}
