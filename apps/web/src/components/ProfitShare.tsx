/**
 * A partnership's year end: the last whole year's profit (or loss), shared between the partners
 * by their shares into their current accounts (server: modules/partners.ts).
 */
import { formatDate, formatZar } from '@shap/shared';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { useToast } from './ui';

interface Share {
  fy: { start: string; end: string; label: string };
  profitCents: number;
  totalBp: number;
  parts: { partnerId: string; name: string; shareBp: number; cents: number }[];
  posted: { journalId: string; profitCents: number; createdAt: string } | null;
  locked: boolean;
}

const pct = (bp: number) => `${(bp / 100).toLocaleString('en-ZA', { maximumFractionDigits: 2 })}%`;

export function ProfitShare({ fyEnd }: { fyEnd?: string }) {
  const { settings, isOwner } = useAuthed();
  const toast = useToast();
  const { data, reload } = useApi<Share>(settings.businessType === 'partnership' ? `/api/partners/profit-share${fyEnd ? `?fyEnd=${fyEnd}` : ''}` : null);
  const [busy, setBusy] = useState(false);
  if (settings.businessType !== 'partnership' || !data) return null;
  const loss = data.profitCents < 0;
  const changed = data.posted && Number(data.posted.profitCents) !== data.profitCents;
  const act = async (undo: boolean) => {
    setBusy(true);
    try {
      if (undo) await api(`/api/partners/profit-share/${data.fy.end}`, { method: 'DELETE' });
      else await api('/api/partners/profit-share', { body: { fyEnd: data.fy.end } });
      toast(undo ? 'Profit share taken out of the books' : `${loss ? 'Loss' : 'Profit'} shared into the partners’ current accounts`);
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel panel-pad stack">
      <h3>
        Share {data.fy.label}’s {loss ? 'loss' : 'profit'} between the partners
      </h3>
      <p className="small">
        The year to {formatDate(data.fy.end)} made a {loss ? 'loss' : 'profit'} of <strong>{formatZar(Math.abs(data.profitCents))}</strong>.{' '}
        {data.posted
          ? `It was shared on ${formatDate(data.posted.createdAt.slice(0, 10))}${changed ? `, when it was ${formatZar(Math.abs(Number(data.posted.profitCents)))}: share it again to bring the partners’ accounts up to date` : ''}.`
          : 'Sharing it moves it into the partners’ current accounts, one journal on the last day of the year.'}
      </p>
      {data.parts.length > 0 ? (
        <table className="table">
          <tbody>
            {data.parts.map((p) => (
              <tr key={p.partnerId}>
                <td>
                  {p.name} <span className="xs muted">({pct(p.shareBp)})</span>
                </td>
                <td className="num">{formatZar(p.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="small muted">Add the partners and their shares under Settings → Your business first.</p>
      )}
      {data.totalBp !== 10000 && data.parts.length > 0 && <div className="banner signal small">The partners’ shares add up to {pct(data.totalBp)}: they need to add up to 100% (Settings → Your business).</div>}
      {data.locked && <p className="xs muted">The books are closed for this year, so the share can’t change.</p>}
      {isOwner && !data.locked && (
        <div className="row wrap">
          <button className="btn primary" disabled={busy || !data.profitCents || data.totalBp !== 10000 || !data.parts.length || (Boolean(data.posted) && !changed)} onClick={() => void act(false)}>
            {data.posted ? 'Share it again' : `Share the ${loss ? 'loss' : 'profit'}`}
          </button>
          {data.posted && (
            <button className="btn quiet" disabled={busy} onClick={() => void act(true)}>
              Undo
            </button>
          )}
        </div>
      )}
    </section>
  );
}
