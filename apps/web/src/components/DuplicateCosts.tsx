import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatZar } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { Empty, ErrorBox, Loading, useToast } from './ui';

interface Pair {
  kind: 'imported_twice' | 'captured_twice';
  removeId: string;
  date: string;
  amountCents: number;
  description: string;
  supplier: string;
  category: string;
  source: string | null;
  projectName: string | null;
  projectNumber: number | null;
  fromStatement: boolean;
  lineAccount: string | null;
  keepId: string | null;
  keepDate: string | null;
  keepAmountCents: number | null;
  keepDescription: string;
  keepSupplier: string;
  keepCategory: string | null;
  keepSource: string | null;
  keepProjectId: string | null;
  keepProjectName: string | null;
  keepProjectNumber: number | null;
  keepLineAccount: string | null;
}

interface Merge {
  id: string;
  at: string;
  undoneAt: string | null;
  date: string;
  amountCents: number;
  description: string;
  supplier: string;
  linesDropped: number;
  keptId: string | null;
  keptDescription: string | null;
  keptDate: string | null;
  keptProjectNumber: number | null;
  keptProjectName: string | null;
}

/**
 * The same purchase in the books twice. Merging keeps one (its job, type and slip) and removes
 * the other; every merge can be undone from the list below.
 */
export function DuplicateCosts() {
  const { isOwner } = useAuthed();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Pair[]>('/api/costs/duplicates');
  const merges = useApi<Merge[]>('/api/costs/merges');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  // Tick everything the first time a pair shows up; after that, your ticks are yours.
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    setPicked((p) => {
      const n = new Set([...p].filter((id) => data.some((d) => d.removeId === id)));
      for (const d of data) if (!seen.current.has(d.removeId)) (seen.current.add(d.removeId), n.add(d.removeId));
      return n;
    });
  }, [data]);

  const merge = async () => {
    const pairs = (data ?? []).filter((p) => picked.has(p.removeId)).map((p) => ({ removeId: p.removeId, keepId: p.keepId }));
    if (!pairs.length || !confirm(`Merge ${pairs.length}? Each one can be undone from Recent merges below.`)) return;
    setBusy(true);
    try {
      const r = await api<{ merged: number; results: { removeId: string; ok: boolean; reason?: string }[] }>('/api/costs/merge', { body: { pairs, byHand: true } });
      const failed = r.results.filter((x) => !x.ok);
      setProblems(Object.fromEntries(failed.map((f) => [f.removeId, f.reason ?? 'Couldn’t merge'])));
      toast(`${r.merged} merged${failed.length ? ` · ${failed.length} couldn’t be: see the note on each` : ''}`, failed.length && !r.merged ? 'error' : undefined);
      await Promise.all([reload(), merges.reload()]);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t merge', 'error');
    } finally {
      setBusy(false);
    }
  };

  const undo = async (m: Merge) => {
    try {
      await api(`/api/costs/merges/${m.id}/undo`, { body: {} });
      toast('Put back');
      await Promise.all([reload(), merges.reload()]);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t undo', 'error');
    }
  };

  const job = (n: number | null, name: string | null, id?: string | null) =>
    name ? id ? <Link to={`/jobs/${id}`}>#{n} {name}</Link> : `#${n} ${name}` : 'no job';
  const recent = (merges.data ?? []).slice(0, 100);

  return (
    <div className="stack-lg">
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <div className="panel">
          <Empty title="Nothing counted twice">No cost looks like a second copy of another.</Empty>
        </div>
      ) : (
        <div className="stack">
          <div className="banner signal small">
            <strong>Imported twice:</strong> the same bank transaction came in on two statements (often one under the wrong account), and each copy became a
            cost. <strong>Added twice:</strong> you captured the slip, then the statement line was added as a new cost. Merging keeps the one on the right
            (its job, type and slip) and removes the one on the left, with its extra copy of the statement line. Untick any that really were two purchases.
          </div>
          <div className="panel table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {isOwner && (
                    <th style={{ width: 34 }}>
                      <input type="checkbox" aria-label="Tick all" checked={picked.size === data.length} onChange={(e) => setPicked(new Set(e.target.checked ? data.map((p) => p.removeId) : []))} />
                    </th>
                  )}
                  <th>Remove</th>
                  <th>Keep</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.removeId} className={picked.has(p.removeId) ? '' : 'inactive'}>
                    {isOwner && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Merge ${p.description}`}
                          checked={picked.has(p.removeId)}
                          onChange={() =>
                            setPicked((s) => {
                              const n = new Set(s);
                              if (n.has(p.removeId)) n.delete(p.removeId);
                              else n.add(p.removeId);
                              return n;
                            })
                          }
                        />
                      </td>
                    )}
                    <td className="small">
                      <span className={`chip ${p.kind === 'imported_twice' ? 'warn' : ''}`} style={{ marginRight: 6 }}>
                        {p.kind === 'imported_twice' ? 'imported twice' : 'added twice'}
                      </span>
                      {formatDate(p.date)} · {p.description}
                      <div className="xs muted">
                        {p.category} · {p.source ?? 'not captured'} · {job(p.projectNumber, p.projectName)}
                        {p.lineAccount ? ` · on the ${p.lineAccount} statement` : ''}
                      </div>
                      {problems[p.removeId] && <div className="xs warn-text">{problems[p.removeId]}</div>}
                    </td>
                    <td className="small">
                      {p.keepId ? (
                        <>
                          {p.keepDate && formatDate(p.keepDate)} · {p.keepDescription}
                          {p.keepSupplier && p.keepSupplier !== p.keepDescription ? ` – ${p.keepSupplier}` : ''}
                          <div className="xs muted">
                            {p.keepCategory} · {p.keepSource ?? 'not captured'} · {job(p.keepProjectNumber, p.keepProjectName, p.keepProjectId)}
                            {p.keepLineAccount ? ` · on the ${p.keepLineAccount} statement` : ''}
                          </div>
                        </>
                      ) : (
                        <>
                          Already paid for on the {p.keepLineAccount} statement
                          <div className="xs muted">by what’s matched to that line there (a slip captured item by item, say): nothing to keep here</div>
                        </>
                      )}
                    </td>
                    <td className="num nowrap">
                      {formatZar(p.amountCents)}
                      {p.keepAmountCents != null && p.keepAmountCents !== p.amountCents && <div className="xs muted">kept one {formatZar(p.keepAmountCents)}</div>}
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
      )}

      {recent.length > 0 && (
        <section className="stack">
          <h3>Recent merges</h3>
          <div className="panel table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Removed</th>
                  <th>Kept</th>
                  <th className="num">Amount</th>
                  {isOwner && <th />}
                </tr>
              </thead>
              <tbody>
                {recent.map((m) => (
                  <tr key={m.id} className={m.undoneAt ? 'inactive' : ''}>
                    <td className="small nowrap">{new Date(m.at).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td className="small">
                      {formatDate(m.date)} · {m.description}
                      {m.linesDropped > 0 && <div className="xs muted">and its extra statement line</div>}
                    </td>
                    <td className="small">
                      {m.keptId ? (
                        <>
                          {m.keptDate && formatDate(m.keptDate)} · {m.keptDescription ?? '(since deleted)'}
                          {m.keptProjectName && <div className="xs muted">#{m.keptProjectNumber} {m.keptProjectName}</div>}
                        </>
                      ) : (
                        <span className="muted">nothing (paid on the other statement)</span>
                      )}
                    </td>
                    <td className="num nowrap">{formatZar(m.amountCents)}</td>
                    {isOwner && (
                      <td className="nowrap">
                        {m.undoneAt ? (
                          <span className="xs muted">undone</span>
                        ) : (
                          <button className="btn small quiet" onClick={() => void undo(m)}>
                            Undo
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
