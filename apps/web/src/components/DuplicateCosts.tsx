import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatZar } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { Empty, ErrorBox, Loading, useToast } from './ui';

interface Pair {
  copyId: string;
  date: string;
  amountCents: number;
  description: string;
  supplier: string;
  copySource: string | null;
  copyCategory: string;
  originalId: string;
  originalDate: string;
  originalAmountCents: number;
  originalDescription: string;
  originalSupplier: string;
  originalSource: string | null;
  originalCategory: string;
  projectId: string | null;
  projectName: string | null;
  projectNumber: number | null;
  likely: boolean;
  separateOnBank: boolean;
  copyFromStatement: boolean;
  copyProjectName: string | null;
  copyProjectNumber: number | null;
}

/**
 * Costs added from a bank statement that were already captured: the same purchase twice.
 * Merging keeps the captured one (job, type, slip) and ties it to the statement line.
 */
export function DuplicateCosts({ onChanged }: { onChanged?: () => void }) {
  const { isOwner } = useAuthed();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Pair[]>('/api/costs/duplicates');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => setPicked(new Set((data ?? []).filter((p) => p.likely).map((p) => p.copyId))), [data]);

  const merge = async () => {
    setBusy(true);
    try {
      const pairs = (data ?? []).filter((p) => picked.has(p.copyId)).map((p) => ({ copyId: p.copyId, originalId: p.originalId }));
      const r = await api<{ merged: number; failed: { reason: string }[] }>('/api/costs/merge', { body: { pairs, byHand: true } });
      toast(
        `${r.merged} duplicate${r.merged === 1 ? '' : 's'} merged${r.failed.length ? ` · ${r.failed.length} not: ${r.failed[0]!.reason}` : ''}`,
        r.failed.length && !r.merged ? 'error' : undefined,
      );
      await reload();
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t merge', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data?.length)
    return (
      <div className="panel">
        <Empty title="No duplicates">Nothing added from a bank statement looks like a cost you’d already captured.</Empty>
      </div>
    );
  return (
    <div className="stack">
      <div className="banner signal small">
        Two costs from the same supplier, of the same amount, within a few days, where one has no job or was added from a bank statement: most likely
        the same purchase counted twice. Merging keeps the one on the right (its job, type and slip; it also takes the other’s tie to the bank) and
        removes the one on the left. Ones marked to check start unticked: tick them only if they really are one purchase.
      </div>
      <div className="panel table-wrap">
        <table className="table">
          <thead>
            <tr>
              {isOwner && (
                <th style={{ width: 34 }}>
                  <input type="checkbox" aria-label="Tick all" checked={picked.size === data.length} onChange={(e) => setPicked(new Set(e.target.checked ? data.map((p) => p.copyId) : []))} />
                </th>
              )}
              <th>Remove</th>
              <th>Keep</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.copyId}>
                {isOwner && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Merge ${p.description}`}
                      checked={picked.has(p.copyId)}
                      onChange={() =>
                        setPicked((s) => {
                          const n = new Set(s);
                          if (n.has(p.copyId)) n.delete(p.copyId);
                          else n.add(p.copyId);
                          return n;
                        })
                      }
                    />
                  </td>
                )}
                <td className="small">
                  {formatDate(p.date)} · {p.description}
                  {!p.likely && (
                    <span className="chip warn" style={{ marginLeft: 6 }}>
                      {p.separateOnBank ? 'check: two payments on the bank' : 'check'}
                    </span>
                  )}
                  <div className="xs muted">
                    {p.copyCategory} · {p.copySource ?? 'not captured'} · {p.copyProjectName ? `#${p.copyProjectNumber} ${p.copyProjectName}` : 'no job'}
                    {p.copyFromStatement ? ' · from a statement' : ''}
                  </div>
                </td>
                <td className="small">
                  {formatDate(p.originalDate)} · {p.originalDescription}
                  {p.originalSupplier ? ` – ${p.originalSupplier}` : ''}
                  <div className="xs muted">
                    {p.originalCategory} · {p.originalSource ?? 'not captured'} ·{' '}
                    {p.projectId ? <Link to={`/jobs/${p.projectId}`}>#{p.projectNumber} {p.projectName}</Link> : 'no job'}
                  </div>
                </td>
                <td className="num nowrap">
                  {formatZar(p.amountCents)}
                  {p.originalAmountCents !== p.amountCents && <div className="xs muted">captured {formatZar(p.originalAmountCents)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isOwner && (
        <section className="panel panel-pad sticky-bar row">
          <span className="grow small">
            <strong>{picked.size}</strong> of {data.length} ticked
          </span>
          <button className="btn primary" disabled={busy || !picked.size} onClick={() => void merge()}>
            {busy ? 'Merging…' : `Merge ${picked.size}`}
          </button>
        </section>
      )}
    </div>
  );
}
