import { useState, type FormEvent } from 'react';
import { formatDate, todayIso } from '@shap/shared';
import { PageHead } from '../components/Shell';
import { Drawer, Empty, ErrorBox, Field, Loading, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { UNEXPECTED } from '../lib/words';

type Level = 'books' | 'review';
interface Health {
  at: string;
  company: string;
  setupDone: boolean;
  audit: { fail: number; warn: number; items: { level: 'fail' | 'warn'; section: string; text: string }[] };
  statements: { yearEnd: string; failing: string[]; look: string[] } | null;
  lockedThrough: string | null;
  deadlines: { key: string; label: string; due: string; past: boolean }[];
}
interface PracticeClient {
  id: string;
  name: string;
  kind: string;
  archived: boolean;
  level: Level | null;
  health: Health | null;
  healthAt: string | null;
  access: { userId: string; level: Level }[];
}
interface Practice {
  clients: PracticeClient[];
  people: { id: string; name: string; email: string; role: string }[];
}

const LEVEL_WORDS: Record<Level, string> = { books: 'Writes up the books', review: 'Reads them and compiles the statements' };

/**
 * Shap Accountant: the practice's clients, each in a database of its own on this server, with what
 * Shap's checks found in each and the returns coming up. Open one to work in its books with all of
 * Shap's screens; Back to the practice (the bar at the top) comes back here.
 */
export default function PracticePage() {
  const { can } = useAuthed();
  const manage = can('practice.manage');
  const toast = useToast();
  const { data, error, reload } = useApi<Practice>('/api/practice');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [accessFor, setAccessFor] = useState<PracticeClient | null>(null);
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
      await api('/api/practice/clients', { body: { name } });
      toast(`${name} added`);
      setName('');
      await reload();
    });
  };
  const open = (c: PracticeClient) =>
    act(`open-${c.id}`, async () => {
      await api(`/api/practice/clients/${c.id}/open`, { body: {} });
      window.location.assign('/');
    });
  const check = (c: PracticeClient) =>
    act(`check-${c.id}`, async () => {
      await api(`/api/practice/clients/${c.id}/checks`, { body: {} });
      await reload();
    });
  const archive = (c: PracticeClient, archived: boolean) =>
    act(`archive-${c.id}`, async () => {
      if (archived && !confirm(`Archive ${c.name}? Nobody opens it until it's brought back. Its books and backups stay.`)) return;
      await api(`/api/practice/clients/${c.id}/archive`, { body: { archived } });
      await reload();
    });

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const shown = data.clients.filter((c) => showArchived || !c.archived);
  const archivedCount = data.clients.filter((c) => c.archived).length;
  const now = todayIso();
  return (
    <div className="stack-lg">
      <PageHead title="Practice" sub="Shap Accountant: your clients’ books, each kept apart on this server" />
      {manage && (
        <form className="panel panel-pad row wrap" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={add}>
          <Field label="A client whose books you keep" className="grow">
            {(p) => <input {...p} className="input" value={name} maxLength={200} placeholder="Their business’s name" onChange={(e) => setName(e.target.value)} />}
          </Field>
          <button className="btn primary" disabled={!name.trim() || busy === 'add'}>
            {busy === 'add' ? 'Adding…' : 'Add client'}
          </button>
        </form>
      )}
      {shown.length === 0 ? (
        <Empty title="No clients yet">{manage ? 'Add the first one above: it gets a set of books of its own, set up when you first open it.' : 'Nobody has given you a client yet.'}</Empty>
      ) : (
        <section className="stack">
          {shown.map((c) => {
            const h = c.health;
            const next = h?.deadlines.filter((d) => !d.past).slice(0, 3) ?? [];
            const past = h?.deadlines.filter((d) => d.past) ?? [];
            return (
              <article key={c.id} className="panel panel-pad stack">
                <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                  <h3 className="grow" style={{ margin: 0 }}>
                    {c.name}
                    {c.archived && <span className="chip"> Archived</span>}
                  </h3>
                  {!c.archived && (
                    <>
                      <button className="btn small" disabled={busy !== null} onClick={() => void check(c)}>
                        {busy === `check-${c.id}` ? 'Checking…' : 'Run the checks'}
                      </button>
                      <button className="btn small primary" disabled={busy !== null} onClick={() => void open(c)}>
                        {busy === `open-${c.id}` ? 'Opening…' : 'Open their books'}
                      </button>
                    </>
                  )}
                </div>
                {!h ? (
                  <p className="small muted">Not checked yet. Open their books, or run the checks.</p>
                ) : !h.setupDone ? (
                  <p className="small muted">Not set up yet: open their books to answer Shap’s first questions about the business.</p>
                ) : (
                  <div className="stack-sm">
                    <p className="small">
                      <strong>Books audit:</strong> {h.audit.fail === 0 && h.audit.warn === 0 ? 'nothing found' : [h.audit.fail ? `${h.audit.fail} to put right` : '', h.audit.warn ? `${h.audit.warn} to look at` : ''].filter(Boolean).join(', ')}
                      {h.audit.items.length > 0 && (
                        <button className="link-btn small" onClick={() => setOpenFindings(openFindings === c.id ? null : c.id)}>
                          {openFindings === c.id ? ' Hide' : ' Show'}
                        </button>
                      )}
                    </p>
                    {openFindings === c.id && (
                      <ul className="small">
                        {h.audit.items.map((i, n) => (
                          <li key={n} className={i.level === 'fail' ? 'warn-text' : undefined}>
                            {i.section}: {i.text}
                          </li>
                        ))}
                      </ul>
                    )}
                    {h.statements && (
                      <p className="small">
                        <strong>Statements for the year to {formatDate(h.statements.yearEnd)}:</strong>{' '}
                        {h.statements.failing.length === 0 && h.statements.look.length === 0
                          ? 'every check passes'
                          : [h.statements.failing.length ? `${h.statements.failing.length} check${h.statements.failing.length === 1 ? '' : 's'} not passing` : '', h.statements.look.length ? `${h.statements.look.length} to look at` : ''].filter(Boolean).join(', ')}
                      </p>
                    )}
                    <p className="small">
                      <strong>Books closed:</strong> {h.lockedThrough ? `up to ${formatDate(h.lockedThrough)}` : 'not yet'}
                    </p>
                    {(next.length > 0 || past.length > 0) && (
                      <p className="small">
                        <strong>Returns:</strong>{' '}
                        {[...past.map((d) => `${d.label}, was due ${formatDate(d.due)}`), ...next.map((d) => `${d.label}, due ${formatDate(d.due)}${d.due === now ? ' (today)' : ''}`)].join(' · ')}
                      </p>
                    )}
                    <p className="xs muted">Checked {new Date(h.at).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })}.</p>
                  </div>
                )}
                {manage && (
                  <div className="row wrap" style={{ gap: 8 }}>
                    <span className="xs muted grow">
                      {c.access.length === 0
                        ? 'Only you (the owner) open these books.'
                        : `Also opened by ${c.access.map((a) => data.people.find((p) => p.id === a.userId)?.name ?? 'someone').join(', ')}.`}
                    </span>
                    {!c.archived && (
                      <button className="btn small quiet" onClick={() => setAccessFor(c)}>
                        Who opens it
                      </button>
                    )}
                    <button className="btn small quiet" disabled={busy !== null} onClick={() => void archive(c, !c.archived)}>
                      {c.archived ? 'Bring back' : 'Archive'}
                    </button>
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
      <p className="xs muted">
        What’s found and the dates are Shap’s own reading of each client’s books and of SARS’s tables, which may be out of date: estimates for you to check, not advice. Shap files nothing with SARS or CIPC. Shap is free software from
        OpenWorks IT, who are not accountants.
      </p>
      {accessFor && <AccessDrawer client={accessFor} people={data.people} onClose={() => setAccessFor(null)} onSaved={() => (setAccessFor(null), void reload())} />}
    </div>
  );
}

function AccessDrawer({ client, people, onClose, onSaved }: { client: PracticeClient; people: Practice['people']; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [levels, setLevels] = useState<Record<string, Level | ''>>(Object.fromEntries(client.access.map((a) => [a.userId, a.level])));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const access = Object.entries(levels)
        .filter((e): e is [string, Level] => e[1] === 'books' || e[1] === 'review')
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
      title={`Who opens ${client.name}`}
      sub="You, the owner, open every client. Someone given a client also needs “Open the clients they’re given” ticked under Settings → People."
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      }
    >
      {people.length === 0 ? (
        <p className="small muted">There’s nobody else in the practice yet: add them under Settings → People.</p>
      ) : (
        <div className="stack">
          {people.map((p) => (
            <Field key={p.id} label={p.name}>
              {(f) => (
                <select {...f} className="select" value={levels[p.id] ?? ''} onChange={(e) => setLevels({ ...levels, [p.id]: e.target.value as Level | '' })}>
                  <option value="">Doesn’t open it</option>
                  <option value="books">{LEVEL_WORDS.books}</option>
                  <option value="review">{LEVEL_WORDS.review}</option>
                </select>
              )}
            </Field>
          ))}
        </div>
      )}
    </Drawer>
  );
}
