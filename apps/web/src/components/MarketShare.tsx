/**
 * Sharing anonymous market rates (server: modules/market.ts; what's shared: shared/market.ts).
 * On unless switched off, so it's said plainly wherever it can be changed, and nothing is
 * shared until the owner has seen this: in setup, or once on Home.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuthed } from '../lib/session';
import type { Settings } from '../lib/types';
import { useToast } from './ui';

export function MarketWhat() {
  return (
    <span className="xs muted">
      Once a month, the average price you charged last month for each of your trade’s standard items (like “Tiling”, per m²), from issued invoices. Never your name, your
      clients, the invoices, anything you typed, or totals. It’s added into national totals as it arrives and only the totals are kept, to show one day what work
      typically costs in South Africa. Never for advertising or marketing.
    </span>
  );
}

async function save(settings: Settings, changes: Partial<Settings>) {
  const { logoId: _l, ...rest } = { ...settings, ...changes } as Settings & { logoId: string | null };
  await api('/api/settings', { method: 'PUT', body: { ...rest, lockDate: rest.lockDate ?? null } });
}

/** Once, on Home, for books set up before this existed: what's shared, and switching it off. */
export function MarketNote() {
  const { settings, isOwner, refreshReference } = useAuthed();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!isOwner || !settings.marketConsent || settings.marketNoticeSeen) return null;
  const answer = async (keep: boolean) => {
    setBusy(true);
    try {
      await save(settings, { marketConsent: keep, marketNoticeSeen: true });
      await refreshReference();
      toast(keep ? 'Thanks: prices are shared anonymously' : 'Not shared. You can change this in Settings');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel panel-pad stack" style={{ gap: 8 }}>
      <strong className="small">New: Shap shares anonymous prices</strong>
      <MarketWhat />
      <div className="row">
        <button type="button" className="btn small primary" disabled={busy} onClick={() => void answer(true)}>
          That’s fine
        </button>
        <button type="button" className="btn small" disabled={busy} onClick={() => void answer(false)}>
          Switch it off
        </button>
      </div>
    </div>
  );
}
