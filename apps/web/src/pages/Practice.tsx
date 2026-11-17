import { useState, type FormEvent } from 'react';
import { ACCOUNTANT_TERMS_MEANS, ACCOUNTANT_TERMS_URL, ACCOUNTANT_TERMS_VERSION, dayOf, formatDate, LEVEL_WORDS, POCKET_SHARE_NOTE, PRACTICE_NOTE, PRACTICE_TERMS_TICK, STATEMENT_STATUS_LABELS, todayIso, type Level, type StatementStatus } from '@shap/shared';
import { AccountantPoints, AccountantTermsAccept } from '../components/AccountantTerms';
import { PageHead } from '../components/Shell';
import { Drawer, Empty, ErrorBox, Field, Loading, Money, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { UNEXPECTED } from '../lib/words';

type Statements =
  | { yearEnd: string; status: StatementStatus; changedSince: boolean; failing: string[]; look: string[]; assurance: string | null; unapprovedEarlier: string | null; error?: undefined; firstYearEnds?: undefined }
  | { yearEnd: string | null; error: true; firstYearEnds?: undefined }
  | { yearEnd: null; firstYearEnds: string; error?: undefined };
interface Health {
  at: string;
  company: string;
  setupDone: boolean;
  audit: { fail: number; warn: number; items: { level: 'fail' | 'warn'; section: string; text: string }[] };
  statements: Statements | null;
  lockedThrough: string | null;
  pocket?: { number: number; through: string; importedAt: string; added: number; changed: number; removed: number; restored?: boolean } | null;
  deadlines: { key: string; label: string; due: string; past: boolean }[];
}
interface PracticeClient {
  id: string;
  name: string;
  kind: string;
  archived: boolean;
  notUpToDate: boolean;
  level: Level | null;
  health: Health | null;
  healthAt: string | null;
  access: { userId: string; level: Level }[];
  /** On their own Shap: where, what they let the practice do, and whether it's still linked. */
  linked: { host: string; level: Level | null; unlinked: boolean } | null;
}
interface ShareChange {
  key: string;
  date: string;
  description: string;
  cents: number;
}
interface ShareResult {
  number: number;
  through: string;
  first: boolean;
  restored: boolean;
  changes: { added: number; changed: number; removed: number; list: { added: ShareChange[]; changed: ShareChange[]; removed: ShareChange[] } };
}
interface Practice {
  clients: PracticeClient[];
  people: { id: string; name: string; email: string; role: string }[];
}

const SHORT: Record<Level, string> = { books: 'writes up', compile: 'reads and compiles' };
const counted = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Shap Accountant: the practice's clients, each in a database of its own on this server, with what
 * three of Shap's checks found in each and some of the returns coming up. Open one to work in its
 * books with Shap's screens; Back to the practice (the bar at the top) comes back here. Clients'
 * and people's names are marked private, so a feedback screenshot never shows them.
 */
export default function PracticePage() {
  const { can, user, settings } = useAuthed();
  const manage = can('practice.manage');
  const isOwner = user.role === 'owner';
  const toast = useToast();
  const { data, error, reload } = useApi<Practice>('/api/practice');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'kept' | 'imported' | 'pocket' | 'linked'>('kept');
  const [relink, setRelink] = useState<Record<string, string>>({});
  const [shareResult, setShareResult] = useState<{ client: string; result: ShareResult } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [accessFor, setAccessFor] = useState<PracticeClient | null>(null);
  const [backupsFor, setBackupsFor] = useState<PracticeClient | null>(null);
  const [openFindings, setOpenFindings] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
    } finally {
      setBusy(null);
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    void act('add', async () => {
      // A client on their own Shap: the link they made there (Settings → People → Your accountant).
      if (kind === 'linked') {
        const r = await api<{ name: string }>('/api/practice/clients/link', { body: { link: name } });
        toast(`${r.name} linked`);
      } else {
        await api('/api/practice/clients', { body: { name, kind } });
        toast(`${name} added`);
      }
      setName('');
      await reload();
    });
  };
  const linkAgain = (c: PracticeClient) =>
    act(`relink-${c.id}`, async () => {
      await api('/api/practice/clients/link', { body: { link: relink[c.id] ?? '', id: c.id } });
      setRelink({ ...relink, [c.id]: '' });
      toast(`${c.name} linked again`);
      await reload();
    });
  const unlink = (c: PracticeClient) =>
    act(`unlink-${c.id}`, async () => {
      if (!confirm(`Unlink ${c.name}? Your practice no longer opens their books, and their Shap takes your people out of them. Their books stay theirs, on their Shap; to link again, they make you a new link.`)) return;
      const r = await api<{ told: boolean }>(`/api/practice/clients/${c.id}/unlink`, { body: {} });
      toast(r.told ? `${c.name} unlinked` : `${c.name} unlinked here: their Shap didn’t answer, so they may want to unlink it there too`);
      await reload();
    });
  const open = (c: PracticeClient, as?: Level) => {
    // On their own Shap: in a new tab, opened now (before the server answers) so it isn't blocked.
    const tab = c.kind === 'linked' ? window.open('about:blank', '_blank') : null;
    return act(`open-${c.id}`, async () => {
      if (c.kind === 'linked') {
        try {
          const { url } = await api<{ url: string }>(`/api/practice/clients/${c.id}/open`, { body: as ? { as } : {} });
          if (tab) {
            tab.opener = null;
            tab.location.href = url;
          } else window.location.assign(url);
        } catch (err) {
          tab?.close();
          await reload();
          throw err;
        }
        return;
      }
      await api(`/api/practice/clients/${c.id}/open`, { body: as ? { as } : {} });
      // Books brought in from another package open where they're brought in (once set up).
      window.location.assign(c.kind === 'imported' && c.health?.setupDone && (as ?? c.level ?? 'books') === 'books' ? '/accounts?tab=import' : '/');
    });
  };
  const bringInShare = (c: PracticeClient, file: File | undefined) =>
    file &&
    act(`share-${c.id}`, async () => {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const send = (acceptTerms: boolean) => api<ShareResult>(`/api/practice/clients/${c.id}/pocket-share`, { body: { name: file.name, dataBase64, acceptTerms } });
      const terms = `${PRACTICE_TERMS_TICK}\n\n${ACCOUNTANT_TERMS_MEANS}\n\nThe Shap Accountant terms of use: ${ACCOUNTANT_TERMS_URL}`;
      // The first share records the practice's acceptance of the terms for these books.
      const first = !c.health?.pocket;
      if (first && !confirm(terms)) return;
      let result: ShareResult;
      try {
        result = await send(first);
      } catch (err) {
        if (!(err instanceof ApiError && (err.details as { needsTerms?: boolean } | undefined)?.needsTerms)) throw err;
        if (!confirm(terms)) return;
        result = await send(true);
      }
      setShareResult({ client: c.name, result });
      await reload();
    });
  const check = (c: PracticeClient) =>
    act(`check-${c.id}`, async () => {
      await api(`/api/practice/clients/${c.id}/checks`, { body: {} });
      await reload();
    });
  const archive = (c: PracticeClient, archived: boolean) =>
    act(`archive-${c.id}`, async () => {
      if (archived && !confirm(`Archive ${c.name}? Anyone in its books now is taken out, and nobody opens it until it’s brought back. Its books stay on this server, and in its backups.`)) return;
      await api(`/api/practice/clients/${c.id}/archive`, { body: { archived } });
      await reload();
    });

  // The Shap Accountant terms changed, or were never accepted for this practice: its owner accepts
  // them before any client's books open (the server refuses until then).
  if (settings.accountantTermsVersion !== ACCOUNTANT_TERMS_VERSION)
    return (
      <div className="stack-lg narrow-wide">
        <PageHead title="Practice" sub={settings.accountantTermsVersion ? 'The Shap Accountant terms of use have changed' : 'Before you carry on: the Shap Accountant terms of use'} />
        <p className="small muted">
          Nothing in your clients’ books changes meanwhile, except monthly invoices set up there, which are still made on their day.{' '}
          {isOwner ? 'Read the terms, accept them for your practice, and carry on where you were.' : 'The practice’s owner accepts them for the practice before anyone opens a client’s books: ask them to open Practice.'}
        </p>
        {isOwner ? <AccountantTermsAccept onAccepted={reload} /> : <AccountantPoints />}
        {isOwner && <ClientRecords />}
      </div>
    );
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const shown = data.clients.filter((c) => showArchived || !c.archived);
  const archivedCount = data.clients.filter((c) => c.archived).length;
  const now = todayIso();
  const who = (id: string) => data.people.find((p) => p.id === id)?.name ?? 'someone';
  return (
    <div className="stack-lg">
      <PageHead title="Practice" sub="Shap Accountant: your clients’ books, kept here (each in a database of its own) or on their own Shap" />
      <p className="xs muted">{PRACTICE_NOTE}</p>
      {manage && (
        <form className="panel panel-pad row wrap" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={add}>
          <Field label={kind === 'linked' ? 'The link they gave you' : 'A client'} className="grow">
            {(p) => (
              <input
                {...p}
                className="input"
                value={name}
                maxLength={kind === 'linked' ? 400 : 200}
                placeholder={kind === 'linked' ? 'https://their-shap…/link#…' : 'Their business’s name'}
                onChange={(e) => setName(e.target.value)}
                data-private
              />
            )}
          </Field>
          <Field label="Their books are written up">
            {(p) => (
              <select {...p} className="select" value={kind} onChange={(e) => setKind(e.target.value as 'kept' | 'imported' | 'pocket' | 'linked')}>
                <option value="kept">Here, in Shap</option>
                <option value="imported">In another package (brought in from Xero, QuickBooks or Sage)</option>
                <option value="pocket">On Shap Pocket, on their phone (they send you shares)</option>
                <option value="linked">On their own Shap (they give you a link from it)</option>
              </select>
            )}
          </Field>
          <button className="btn primary" disabled={!name.trim() || busy === 'add'}>
            {busy === 'add' ? (kind === 'linked' ? 'Linking…' : 'Adding…') : kind === 'linked' ? 'Link client' : 'Add client'}
          </button>
          {kind === 'linked' && (
            <p className="xs muted" style={{ flexBasis: '100%', margin: 0 }}>
              In their own Shap, the client makes the link under Settings → People → Your accountant, choosing what your practice may do there. Their books stay on their Shap: your people open them there, in a new tab.
            </p>
          )}
        </form>
      )}
      {shown.length === 0 ? (
        <Empty title="No clients yet">{manage ? 'Add the first one above: it gets a set of books of its own, set up when you first open it.' : 'Nobody has given you a client yet.'}</Empty>
      ) : (
        <section className="stack">
          {shown.map((c) => {
            const h = c.health;
            const next = h?.deadlines.filter((d) => !d.past).slice(0, 4) ?? [];
            const past = h?.deadlines.filter((d) => d.past) ?? [];
            const st = h?.statements ?? null;
            const given = isOwner ? 'books' : c.level;
            // (A Shap Pocket client's copy takes only the practice's work on it: the server holds to it.)
            // On their own Shap: never more than they let the practice do; and nothing, unlinked.
            const level = c.linked ? (c.linked.unlinked ? null : given === 'books' && c.linked.level !== 'books' ? 'compile' : given) : given;
            return (
              <article key={c.id} className="panel panel-pad stack">
                <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                  <h3 className="grow" style={{ margin: 0 }} data-private>
                    {c.name}
                    {c.archived && <span className="chip"> Archived</span>}
                    {c.notUpToDate && <span className="chip warn"> Not up to date</span>}
                    {c.kind === 'imported' && <span className="chip"> From another package</span>}
                    {c.kind === 'pocket' && <span className="chip"> Shap Pocket</span>}
                    {c.linked && <span className="chip"> On their own Shap</span>}
                    {c.linked?.unlinked && <span className="chip warn"> Unlinked</span>}
                  </h3>
                  {!c.archived && level && (
                    <>
                      <button className="btn small" disabled={busy !== null || c.notUpToDate} onClick={() => void check(c)}>
                        {busy === `check-${c.id}` ? 'Checking…' : 'Run the checks'}
                      </button>
                      {level === 'books' && (
                        <button className="btn small" disabled={busy !== null || c.notUpToDate} onClick={() => void open(c, 'compile')}>
                          Open to compile
                        </button>
                      )}
                      {c.kind === 'pocket' && given === 'books' && (
                        <label className={`btn small${busy !== null || c.notUpToDate ? ' disabled' : ''}`}>
                          {busy === `share-${c.id}` ? 'Bringing it in…' : 'Bring in a share'}
                          <input type="file" accept=".json,application/json" hidden disabled={busy !== null || c.notUpToDate} onChange={(e) => void bringInShare(c, e.target.files?.[0])} />
                        </label>
                      )}
                      <button className="btn small primary" disabled={busy !== null || c.notUpToDate} onClick={() => void open(c)}>
                        {busy === `open-${c.id}` ? 'Opening…' : level === 'books' ? 'Open their books' : 'Open to compile'}
                      </button>
                    </>
                  )}
                </div>
                {c.linked && (
                  <p className="xs muted" data-private>
                    At {c.linked.host}. They let your practice {c.linked.level === 'books' ? 'write up their books and compile the statements' : 'read their books and compile the statements'}; it opens in a new tab, as someone from your practice there, in their own audit log.
                  </p>
                )}
                {c.linked?.unlinked && manage && (
                  <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
                    <p className="small grow" style={{ margin: 0 }}>
                      They’ve unlinked your practice in their Shap (or it was unlinked here). To link again, paste the new link they make you:
                    </p>
                    <input className="input" style={{ minWidth: 260 }} value={relink[c.id] ?? ''} placeholder="https://their-shap…/link#…" onChange={(e) => setRelink({ ...relink, [c.id]: e.target.value })} data-private aria-label="Their new link" />
                    <button className="btn small" disabled={busy !== null || !(relink[c.id] ?? '').trim()} onClick={() => void linkAgain(c)}>
                      {busy === `relink-${c.id}` ? 'Linking…' : 'Link again'}
                    </button>
                  </div>
                )}
                {c.notUpToDate ? (
                  <p className="small warn-text">Shap couldn’t bring these books up to date when it last started, so they aren’t opened until it can. Whoever runs the server can see why in its log.</p>
                ) : !h ? (
                  <p className="small muted">Shap’s checks haven’t run on these books yet: open them, or run the checks.</p>
                ) : !h.setupDone && c.kind === 'pocket' ? (
                  <p className="small muted">No share brought in yet: bring in their first share from Shap Pocket (they make it under Accounts → Export).</p>
                ) : !h.setupDone ? (
                  <p className="small muted">
                    {level === 'books' ? 'Not set up yet: open their books to answer Shap’s first questions about the business.' : 'Not set up yet: whoever writes up their books answers Shap’s first questions when they first open them.'}
                  </p>
                ) : (
                  <div className="stack-sm">
                    <p className="small">
                      <strong>Books check:</strong> {h.audit.fail === 0 && h.audit.warn === 0 ? 'nothing to fix' : [h.audit.fail ? `${h.audit.fail} to fix` : '', h.audit.warn ? `${h.audit.warn} to look at` : ''].filter(Boolean).join(', ')}
                      {h.audit.items.length > 0 && (
                        <button className="link-btn small" onClick={() => setOpenFindings(openFindings === c.id ? null : c.id)}>
                          {openFindings === c.id ? ' Hide' : ' Show'}
                        </button>
                      )}
                    </p>
                    {openFindings === c.id && (
                      <ul className="small" data-private>
                        {h.audit.items.map((i, n) => (
                          <li key={n} className={i.level === 'fail' ? 'warn-text' : undefined}>
                            {i.section}: {i.text}
                          </li>
                        ))}
                        {h.audit.fail + h.audit.warn > h.audit.items.length && <li className="muted">(the first {h.audit.items.length}: open their books for the rest)</li>}
                      </ul>
                    )}
                    {st?.error ? (
                      <p className="small warn-text">
                        <strong>Statements{st.yearEnd ? ` for the year to ${formatDate(st.yearEnd)}` : ''}:</strong> Shap’s checks couldn’t run on them. Open their books and look.
                      </p>
                    ) : st?.firstYearEnds ? (
                      <p className="small">
                        <strong>Statements:</strong> their first year in these books ends {formatDate(st.firstYearEnds)}.
                      </p>
                    ) : (
                      st &&
                      'status' in st && (
                        <>
                          <p className="small">
                            <strong>Statements for the year to {formatDate(st.yearEnd)}</strong> ({STATEMENT_STATUS_LABELS[st.status].toLowerCase()}):{' '}
                            {st.changedSince
                              ? 'the books have changed since they were signed, so they no longer give the signed figures'
                              : st.status === 'approved'
                                ? 'signed'
                                : st.failing.length === 0 && st.look.length === 0
                                  ? 'Shap’s checks pass'
                                  : [st.failing.length ? `${counted(st.failing.length, 'check')} not passing` : '', st.look.length ? `${st.look.length} to look at` : ''].filter(Boolean).join(', ')}
                          </p>
                          {st.assurance && st.status !== 'approved' && (
                            <p className="small">
                              <strong>Assurance:</strong> {st.assurance}
                              {/audit/i.test(st.assurance) ? '' : ' The independent reviewer can’t be anyone in your practice who prepared or compiled them (Companies Regulation 29(5)).'}
                            </p>
                          )}
                          {st.unapprovedEarlier && (
                            <p className="small">
                              <strong>Earlier:</strong> the statements for the year to {formatDate(st.unapprovedEarlier)} aren’t approved in Shap.
                            </p>
                          )}
                        </>
                      )
                    )}
                    {h.pocket && (
                      <p className="small">
                        <strong>Their last share:</strong> share {h.pocket.number}, their books as at {formatDate(h.pocket.through)}, brought in {formatDate(dayOf(h.pocket.importedAt))}
                        {h.pocket.restored ? ` (${POCKET_RESTORED_SHORT})` : h.pocket.added + h.pocket.changed + h.pocket.removed > 0 ? `: ${h.pocket.added} new, ${h.pocket.changed} changed and ${h.pocket.removed} gone since the share before` : ''}.
                      </p>
                    )}
                    <p className="small">
                      <strong>Books closed:</strong> {h.lockedThrough ? `up to ${formatDate(h.lockedThrough)}` : 'not yet'}
                    </p>
                    {(next.length > 0 || past.length > 0) && (
                      <p className="small">
                        <strong>Some returns coming up:</strong>{' '}
                        {[
                          ...past.map((d) => `${d.label}, was due ${formatDate(d.due)} (Shap can’t tell whether it was filed)`),
                          ...next.map((d) => `${d.label}, due ${formatDate(d.due)}${d.due === now ? ' (today)' : ''}`),
                        ].join(' · ')}
                      </p>
                    )}
                    <p className="xs muted">Shap’s checks ran {formatDate(h.at.slice(0, 10))}.</p>
                  </div>
                )}
                {(manage || isOwner) && (
                  <div className="row wrap" style={{ gap: 8 }}>
                    <span className="xs muted grow" data-private>
                      {c.access.length === 0 ? 'Only the practice’s owner opens these books.' : `Also opened by ${c.access.map((a) => `${who(a.userId)} (${SHORT[a.level]})`).join(', ')}.`}
                    </span>
                    {manage && !c.archived && (
                      <button className="btn small quiet" onClick={() => setAccessFor(c)}>
                        Who opens it
                      </button>
                    )}
                    {isOwner && !c.linked && (
                      <button className="btn small quiet" onClick={() => setBackupsFor(c)}>
                        Their backups
                      </button>
                    )}
                    {manage && c.linked && !c.linked.unlinked && (
                      <button className="btn small quiet" disabled={busy !== null} onClick={() => void unlink(c)}>
                        Unlink
                      </button>
                    )}
                    {manage && (!c.linked || c.linked.unlinked) && (
                      <button className="btn small quiet" disabled={busy !== null} onClick={() => void archive(c, !c.archived)}>
                        {c.archived ? 'Bring back' : 'Archive'}
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}
      {archivedCount > 0 && (
        <button className="link-btn small" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'Hide archived clients' : `Show archived clients (${archivedCount})`}
        </button>
      )}
      {accessFor && <AccessDrawer client={accessFor} people={data.people} onClose={() => setAccessFor(null)} onSaved={() => (setAccessFor(null), void reload())} />}
      {backupsFor && <BackupsDrawer client={backupsFor} onClose={() => setBackupsFor(null)} />}
      {shareResult && <ShareDrawer client={shareResult.client} result={shareResult.result} onClose={() => setShareResult(null)} />}
    </div>
  );
}

/** Who opens it: what writing up a client's books lets someone do (docs/ACCOUNTANT.md, "Who opens which"). */
const WHO_OPENS_KEPT =
  'As their owner in Shap, someone who writes up the books can do everything the client’s owner could, reopening closed periods included, and records the client’s approval of the financial statements (with the page they signed). Approving the statements is the client’s own decision.';
const WHO_OPENS_POCKET =
  'Their books change only in Shap Pocket (on their phone or computer). Someone who writes them up here brings in their shares, compiles the statements and records the approval of whoever signs them for the business (with the page they signed): approving the statements is the client’s own decision.';
const WHO_OPENS_LINKED =
  'Their books are on their own Shap, and they choose what your practice may do there. Someone who writes them up does that, as staff with every task but closing and reopening months (never their settings, the people who sign in, the year end or approving the statements); someone given them to compile reads them and compiles the statements. Each opens them there, in a new tab, in the client’s own audit log by name. Approving the statements is the client’s own decision.';
/** A share numbered lower than the last, made later: what Shap takes it to mean, not what it knows. */
const POCKET_RESTORED =
  'It numbers lower than the share before but was made later, which usually means their books were restored from a backup or begun again in Shap Pocket: check with them that this is the share they meant to send.';
const POCKET_RESTORED_SHORT = 'numbered lower than the share before: their books restored in Shap Pocket, it seems';

function AccessDrawer({ client, people, onClose, onSaved }: { client: PracticeClient; people: Practice['people']; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [levels, setLevels] = useState<Record<string, Level | ''>>(Object.fromEntries(client.access.map((a) => [a.userId, a.level])));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const access = Object.entries(levels)
        .filter((e): e is [string, Level] => e[1] === 'books' || e[1] === 'compile')
        .map(([userId, level]) => ({ userId, level }));
      await api(`/api/practice/clients/${client.id}/access`, { method: 'PUT', body: { access } });
      toast('Saved');
      onSaved();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={<span data-private>Who opens {client.name}</span>}
      sub="The practice’s owner opens every client. Someone given a client also needs “Open the clients they’re given” ticked under Settings → People who sign in."
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      }
    >
      {people.length === 0 ? (
        <p className="small muted">There are no staff in the practice yet: add them under Settings → People who sign in. (A read-only accountant can’t be given a client.)</p>
      ) : (
        <div className="stack">
          {people.map((p) => (
            <div key={p.id} data-private>
              <Field label={p.name}>
                {(f) => (
                  <select {...f} className="select" value={levels[p.id] ?? ''} onChange={(e) => setLevels({ ...levels, [p.id]: e.target.value as Level | '' })}>
                    <option value="">Doesn’t open it</option>
                    <option value="books">{LEVEL_WORDS.books}</option>
                    <option value="compile">{LEVEL_WORDS.compile}</option>
                  </select>
                )}
              </Field>
            </div>
          ))}
          <p className="xs muted">{client.kind === 'pocket' ? WHO_OPENS_POCKET : client.kind === 'linked' ? WHO_OPENS_LINKED : WHO_OPENS_KEPT}</p>
        </div>
      )}
    </Drawer>
  );
}

/** A client's own backups, for the practice's owner: each download takes the owner's password. */
/**
 * Before the Shap Accountant terms are accepted: each client's backups, so a practice can hand a
 * client its books, or keep them as the law asks, whether or not it accepts them.
 */
function ClientRecords() {
  const { data } = useApi<{ clients: { id: string; name: string; archived: boolean }[] }>('/api/practice/records');
  const [backupsFor, setBackupsFor] = useState<{ id: string; name: string } | null>(null);
  if (!data?.clients.length) return null;
  return (
    <section className="panel panel-pad stack">
      <strong className="small">Your clients’ backups</strong>
      <p className="xs muted">To hand a client its books, or keep them as the law asks, whether or not you accept the terms.</p>
      <ul className="list" data-private>
        {data.clients.map((c) => (
          <li key={c.id} className="list-row">
            <span className="grow small">
              {c.name}
              {c.archived ? ' (archived)' : ''}
            </span>
            <button type="button" className="btn small" onClick={() => setBackupsFor(c)}>
              Backups
            </button>
          </li>
        ))}
      </ul>
      {backupsFor && <BackupsDrawer client={backupsFor} onClose={() => setBackupsFor(null)} />}
    </section>
  );
}

function BackupsDrawer({ client, onClose }: { client: Pick<PracticeClient, 'id' | 'name'>; onClose: () => void }) {
  const toast = useToast();
  const { data, error } = useApi<{ backups: { name: string; sizeBytes: number; at: string }[] }>(`/api/practice/clients/${client.id}/backups`);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const download = async (name: string) => {
    setBusy(name);
    try {
      const { url } = await api<{ url: string }>(`/api/practice/clients/${client.id}/backups/${encodeURIComponent(name)}/link`, { body: { password } });
      window.location.assign(url);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Drawer title={<span data-private>{client.name}: their backups</span>} sub="The server’s own copies of these books, to hand to the client or to keep as the law asks (Companies Act s24)" onClose={onClose}>
      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : data.backups.length === 0 ? (
        <p className="small muted">No backups of these books on the server yet: the server makes them each night, where it’s set up to.</p>
      ) : (
        <div className="stack">
          <Field label="Your password, to download one">{(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <ul className="list">
            {data.backups.map((b) => (
              <li key={b.name} className="list-row">
                <span className="grow small">
                  {formatDate(b.at.slice(0, 10))} · {(b.sizeBytes / 1_048_576).toFixed(1)} MB
                </span>
                <button className="btn small" disabled={!password || busy !== null} onClick={() => void download(b.name)}>
                  {busy === b.name ? '…' : 'Download'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Drawer>
  );
}

/** What a Pocket share brought in: the whole of their books the first time; then what's new, changed and gone. */
function ShareDrawer({ client, result, onClose }: { client: string; result: ShareResult; onClose: () => void }) {
  const list = (title: string, items: ShareChange[], count: number) =>
    count > 0 && (
      <section className="stack-sm">
        <strong className="small">
          {title} ({count})
        </strong>
        <ul className="list small" data-private>
          {items.slice(0, 200).map((x) => (
            <li key={x.key} className="list-row">
              <span className="grow">
                {formatDate(x.date)} · {x.description || 'No description'}
              </span>
              <Money cents={x.cents} />
            </li>
          ))}
          {count > items.length && <li className="list-row muted">and {count - items.length} more</li>}
        </ul>
      </section>
    );
  const { added, changed, removed, list: shown } = result.changes;
  return (
    <Drawer title={<span data-private>{client}: share {result.number}</span>} sub={result.first ? 'The first share: the whole of their books, brought in' : 'Brought in: what changed since the share before'} onClose={onClose}>
      <div className="stack">
        <p className="small">
          Their books are here as the share has them, as at {formatDate(result.through)}.{result.restored ? ` ${POCKET_RESTORED}` : ''}
        </p>
        {result.first ? (
          <p className="small">Each share after this one says what’s new, what changed and what’s gone.</p>
        ) : added + changed + removed === 0 ? (
          <p className="small">Nothing changed since the share before.</p>
        ) : (
          <>
            {list('New', shown.added, added)}
            {list('Changed', shown.changed, changed)}
            {list('Gone', shown.removed, removed)}
          </>
        )}
        <p className="xs muted">{POCKET_SHARE_NOTE}</p>
      </div>
    </Drawer>
  );
}
