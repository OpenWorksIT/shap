/**
 * Practice → a client → Working papers and letters (docs/ACCOUNTANT.md, "Engagement letters and
 * working papers"): the practice's engagement letters with the client, and its working papers for
 * each of the client's ended years (review notes, the trial balance ticked as prepared and reviewed,
 * and the year's sign-offs). The practice's own record, on its server (server
 * modules/working-papers.ts): checks for the practitioner, never locks.
 */
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import {
  ACCEPTED_HOW,
  FILE_NOTE,
  formatDate,
  LETTER_END_CONFIRM,
  LETTER_NOTE,
  LETTER_SENT_CONFIRM,
  SERVICE_WORDS,
  SERVICES,
  SIGNOFF_WORDS,
  SIGNOFFS,
  todayIso,
  type AcceptedHow,
  type Level,
  type LetterStatus,
  type Service,
  type Signoff,
} from '@shap/shared';
import { PageHead } from '../components/Shell';
import { Drawer, ErrorBox, Field, Loading, Money, useToast } from '../components/ui';
import { api, apiUrl, ApiError } from '../lib/api';
import { fileToBase64, squeezePhoto } from '../lib/files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { UNEXPECTED } from '../lib/words';

interface Section {
  heading: string;
  paragraphs: string[];
}
interface Parties {
  practiceName: string;
  practiceReg: string;
  practiceTrading: string;
  practiceAddress: string;
  clientName: string;
}
interface Letter extends Parties {
  id: string;
  services: Service[];
  other: string;
  fromYearEnd: string;
  body: Section[];
  status: LetterStatus;
  createdBy: string | null;
  createdAt: string;
  sentAt: string | null;
  sentBy: string | null;
  acceptedOn: string | null;
  acceptedName: string | null;
  acceptedCapacity: string | null;
  acceptedHow: AcceptedHow | null;
  endedAt: string | null;
  lastYearEnd: string | null;
  signedName: string | null;
  years: { fyEnd: string; by: string | null; at: string }[];
}
interface Tick {
  by: string;
  at: string;
  changed: boolean;
  samePerson?: boolean;
}
interface FileHead {
  client: { id: string; name: string; kind: string; archived: boolean };
  level: Level;
  owner: boolean;
  years: string[];
  /** This year's end and the next: not ended yet, for a new letter. */
  coming: string[];
}
type File =
  | (FileHead & { empty: true; fyEnd: null })
  | (FileHead & {
      empty: false;
      fyEnd: string;
      ticksHere: boolean;
      letter: { accepted: boolean; compiling: boolean; termsLooked: boolean };
      statements: { status: string; compiledOn: string | null; approvedOn: string | null } | null;
      lines: { accountId: string; code: string; name: string; debitCents: number; creditCents: number; balanceCents: number; prepared: Tick | null; reviewed: Tick | null }[] | null;
      totals: { debitCents: number; creditCents: number; differenceCents: number } | null;
      gone: { code: string; name: string }[];
      notes: { id: string; account: { code: string; name: string | null } | null; text: string; raisedBy: string; raisedAt: string; mine: boolean; cleared: { by: string; at: string } | null; replies: { text: string; by: string; at: string }[] }[];
      signoffs: Record<Signoff, { by: string; mine: boolean; at: string; changed: boolean } | null>;
    });

const day = (at: string | null | undefined) => (at ? formatDate(at.slice(0, 10)) : '');
const STATUS_WORDS: Record<LetterStatus, string> = { draft: 'Draft', sent: 'Sent, not accepted yet', accepted: 'Accepted', ended: 'Ended' };
/** What taking back sign-offs said, for a toast. */
const removedWords = (removed: Signoff[] | undefined) => (removed?.length ? `: the ${removed.map((r) => SIGNOFF_WORDS[r].toLowerCase()).join(' and ')} sign-off${removed.length > 1 ? 's were' : ' was'} taken back` : '');
/** The most a signed copy may be, after a photo is shrunk (the server takes 6 MB). */
const SIGNED_MAX = 6 * 1024 * 1024;

export default function PracticeFilePage() {
  const { id = '' } = useParams();
  const { can } = useAuthed();
  const toast = useToast();
  const manage = can('practice.manage');
  const [fy, setFy] = useState<string | null>(null);
  const file = useApi<File>(`/api/practice/clients/${id}/file${fy ? `?fy=${fy}` : ''}`);
  const letters = useApi<{ note: string; letters: Letter[] }>(`/api/practice/clients/${id}/letters`);
  const [busy, setBusy] = useState<string | null>(null);
  const [newLetter, setNewLetter] = useState(false);
  const [editing, setEditing] = useState<Letter | null>(null);
  const [accepting, setAccepting] = useState<Letter | null>(null);
  const [ending, setEnding] = useState<Letter | null>(null);
  const [note, setNote] = useState({ account: '', text: '' });
  const [reply, setReply] = useState<Record<string, string>>({});

  const act = async <T,>(key: string, fn: () => Promise<T>, done?: string | ((r: T) => string)) => {
    setBusy(key);
    try {
      const r = await fn();
      await Promise.all([file.reload(), letters.reload()]);
      if (done) toast(typeof done === 'function' ? done(r) : done);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
    } finally {
      setBusy(null);
    }
  };
  const f = file.data;
  if (file.error) return <ErrorBox error={file.error} onRetry={() => void file.reload()} />;
  if (!f) return <Loading />;
  const base = `/api/practice/clients/${id}`;
  const writes = !f.client.archived;

  return (
    <div className="stack-lg">
      <PageHead title={<span data-private>{f.client.name}</span>} sub="Working papers and letters" back={{ to: '/practice', label: 'Practice' }} />
      {f.client.archived && <div className="banner small">This client is archived: its letters and working papers are kept as they are.</div>}

      {/* ------------------------------------------------------------- letters */}
      <section className="stack">
        <div className="row wrap">
          <h2 className="strong grow" style={{ fontSize: 'var(--fs-md)', margin: 0 }}>
            Engagement letters
          </h2>
          {manage && writes && (
            <button className="btn small" onClick={() => setNewLetter(true)}>
              New letter
            </button>
          )}
        </div>
        <p className="xs muted">{LETTER_NOTE}</p>
        <p className="xs muted">Shap doesn’t send a letter: read its draft, change it as you like, mark it as sent (its words are kept from then), then download its PDF and send it to them yourself.</p>
        {!letters.data ? (
          <Loading />
        ) : letters.data.letters.length === 0 ? (
          <p className="small muted">No engagement letter for them yet{manage ? ': make one, read it, change it as you like, and send it.' : '.'}</p>
        ) : (
          <ul className="panel list">
            {letters.data.letters.map((l) => {
              const laterYears = f.years.filter((y) => y > l.fromYearEnd && !l.years.some((x) => x.fyEnd === y));
              return (
                <li key={l.id} className="list-row stack-sm" style={{ alignItems: 'stretch', flexDirection: 'column' }}>
                  <span className="stack-sm">
                    <strong className="small">
                      {STATUS_WORDS[l.status]}: from the year to {day(l.fromYearEnd)}
                    </strong>
                    <span className="xs muted">
                      {[...l.services.map((s) => SERVICE_WORDS[s]), ...(l.other ? [l.other] : [])].join('; ')}.
                    </span>
                    <span className="xs muted" data-private>
                      {[
                        l.sentAt ? `Sent ${day(l.sentAt)}${l.sentBy ? ` by ${l.sentBy}` : ''}` : `Drafted ${day(l.createdAt)}${l.createdBy ? ` by ${l.createdBy}` : ''}`,
                        l.acceptedOn ? `${l.acceptedHow === 'signed' ? 'signed' : 'accepted'} by ${l.acceptedName}${l.acceptedCapacity ? ` (${l.acceptedCapacity})` : ''} on ${day(l.acceptedOn)}` : '',
                        ...l.years.map((y) => `terms looked at again for the year to ${day(y.fyEnd)}${y.by ? ` by ${y.by}` : ''}`),
                        l.endedAt ? `ended in Shap ${day(l.endedAt)}${l.lastYearEnd ? `, the last year it covers the year to ${day(l.lastYearEnd)}` : ', covering no year'}` : '',
                      ]
                        .filter(Boolean)
                        .join('; ')}
                      .
                    </span>
                  </span>
                  <span className="row wrap" style={{ gap: 6 }}>
                    <a className="btn small quiet" href={apiUrl(`${base}/letters/${l.id}/pdf`)}>
                      {l.status === 'draft' ? 'Draft PDF (to read)' : 'PDF'}
                    </a>
                    {l.signedName && (
                      <a className="btn small quiet" href={apiUrl(`${base}/letters/${l.id}/signed`)}>
                        Signed copy
                      </a>
                    )}
                    {manage && writes && l.status === 'draft' && (
                      <>
                        <button className="btn small quiet" onClick={() => setEditing(l)}>
                          Change the words
                        </button>
                        <button
                          className="btn small"
                          disabled={busy !== null}
                          onClick={() => {
                            if (confirm(`Mark this letter as sent? ${LETTER_SENT_CONFIRM}`)) void act(`sent-${l.id}`, () => api(`${base}/letters/${l.id}/sent`, { body: {} }), 'Marked as sent: download its PDF to send it');
                          }}
                        >
                          Mark as sent
                        </button>
                        <button
                          className="btn small quiet"
                          disabled={busy !== null}
                          onClick={() => {
                            if (confirm('Delete this draft?')) void act(`del-${l.id}`, () => api(`${base}/letters/${l.id}`, { method: 'DELETE' }), 'Deleted');
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    {manage && writes && l.status === 'sent' && (
                      <button className="btn small" onClick={() => setAccepting(l)}>
                        Record their acceptance
                      </button>
                    )}
                    {manage && writes && l.status === 'accepted' && laterYears[0] && (
                      <button
                        className="btn small quiet"
                        disabled={busy !== null}
                        onClick={() => void act(`year-${l.id}`, () => api(`${base}/letters/${l.id}/years`, { body: { fyEnd: laterYears[laterYears.length - 1] } }), 'Recorded')}
                      >
                        Terms still fit for the year to {day(laterYears[laterYears.length - 1])}
                      </button>
                    )}
                    {manage && writes && (l.status === 'sent' || l.status === 'accepted') && (
                      <button className="btn small quiet" disabled={busy !== null} onClick={() => setEnding(l)}>
                        End
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------- the year's file */}
      {f.empty ? (
        <section className="stack">
          <h2 className="strong" style={{ fontSize: 'var(--fs-md)', margin: 0 }}>
            Working papers
          </h2>
          <p className="small muted">No year of theirs has ended in their books yet: the working papers open for each year once it has.</p>
        </section>
      ) : (
        <YearFile f={f} base={base} busy={busy} writes={writes} act={act} setFy={setFy} note={note} setNote={setNote} reply={reply} setReply={setReply} />
      )}

      {newLetter && <NewLetter base={base} years={f.years} coming={f.coming} pocket={f.client.kind === 'pocket'} onClose={() => setNewLetter(false)} onDone={() => void Promise.all([letters.reload(), file.reload()])} />}
      {editing && <EditLetter base={base} letter={editing} onClose={() => setEditing(null)} onDone={() => void letters.reload()} />}
      {accepting && <AcceptLetter base={base} letter={accepting} onClose={() => setAccepting(null)} onDone={() => void Promise.all([letters.reload(), file.reload()])} />}
      {ending && <EndLetter base={base} letter={ending} years={[f.coming[f.coming.length - 1] ?? '', ...f.years]} onClose={() => setEnding(null)} onDone={() => void Promise.all([letters.reload(), file.reload()])} />}
    </div>
  );
}

type Act = <T>(key: string, fn: () => Promise<T>, done?: string | ((r: T) => string)) => Promise<void>;

function YearFile({
  f,
  base,
  busy,
  writes,
  act,
  setFy,
  note,
  setNote,
  reply,
  setReply,
}: {
  f: Extract<File, { empty: false }>;
  base: string;
  busy: string | null;
  writes: boolean;
  act: Act;
  setFy: (y: string) => void;
  note: { account: string; text: string };
  setNote: (n: { account: string; text: string }) => void;
  reply: Record<string, string>;
  setReply: (r: Record<string, string>) => void;
}) {
  const open = f.notes.filter((n) => !n.cleared).length;
  const given = SIGNOFFS.some((r) => r !== 'prepared' && f.signoffs[r]);
  return (
    <section className="stack">
      <div className="row wrap">
        <h2 className="strong grow" style={{ fontSize: 'var(--fs-md)', margin: 0 }}>
          Working papers for the year to {day(f.fyEnd)}
        </h2>
        <a className="btn small quiet" href={apiUrl(`${base}/file/pdf?fy=${f.fyEnd}`)}>
          Download the year’s file (PDF)
        </a>
      </div>
      <div className="row wrap">
        {f.years.map((y) => (
          <button key={y} type="button" className={`btn small ${y === f.fyEnd ? 'primary' : ''}`} onClick={() => setFy(y)}>
            {day(y)}
          </button>
        ))}
      </div>
      <p className="xs muted">{FILE_NOTE}</p>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        <li className={f.letter.accepted ? undefined : 'warn-text'}>
          {!f.letter.accepted
            ? 'No engagement letter accepted for this year is recorded.'
            : f.letter.compiling
              ? 'An accepted letter covers compiling the statements for this year.'
              : 'An accepted letter covers this year, but not compiling the statements.'}
        </li>
        {f.letter.accepted && !f.letter.termsLooked && <li className="warn-text">Its terms aren’t recorded as looked at again for this year (ISRS 4410 (Revised) para 26): under Engagement letters, above.</li>}
        {open > 0 && <li className="warn-text">{open === 1 ? 'One review note is' : `${open} review notes are`} still open.</li>}
        <li>
          {f.statements
            ? `The statements: ${f.statements.compiledOn ? `compiled on ${day(f.statements.compiledOn)}` : 'not compiled yet'}, ${f.statements.approvedOn ? `approved on ${day(f.statements.approvedOn)}` : 'not approved yet'}. Keep a copy of the final set and the compilation report with this year’s file (ISRS 4410 (Revised) para 38(c)): ${f.client.kind === 'pocket' ? 'what’s here is a copy of their Shap Pocket share' : 'their books go back to them when the engagement ends'}.`
            : 'Their books and statements are on their own Shap: download the signed set and the compilation report there, and keep them with this year’s file (ISRS 4410 (Revised) para 38(c)). They aren’t here once they unlink you.'}
        </li>
      </ul>

      <div className="panel panel-pad stack-sm">
        <strong className="small">Sign-offs</strong>
        {SIGNOFFS.map((r) => {
          const s = f.signoffs[r];
          const mayGive = writes && (r === 'partner' ? f.owner : r === 'prepared' ? f.level === 'books' : true);
          return (
            <div key={r} className="row wrap" style={{ gap: 8 }}>
              <span className="small grow" data-private>
                <strong>{SIGNOFF_WORDS[r]}:</strong> {s ? `${s.by}, ${day(s.at)}` : 'not yet'}
                {s?.changed && <span className="warn-text"> (the books have changed since)</span>}
                {r === 'partner' && s && !f.signoffs.reviewed && <span className="warn-text"> (not reviewed)</span>}
              </span>
              {s && (s.mine || f.owner) && writes ? (
                <button className="btn small quiet" disabled={busy !== null} onClick={() => void act(`un-${r}`, () => api(`${base}/file/signoffs`, { method: 'PUT', body: { fyEnd: f.fyEnd, role: r, on: false } }), 'Taken back')}>
                  Take back
                </button>
              ) : (
                !s &&
                mayGive && (
                  <button className="btn small" disabled={busy !== null} onClick={() => void act(`sign-${r}`, () => api(`${base}/file/signoffs`, { method: 'PUT', body: { fyEnd: f.fyEnd, role: r, on: true } }), 'Signed off')}>
                    Sign off
                  </button>
                )
              )}
            </div>
          );
        })}
        <p className="xs muted">Reviewed and the engagement partner’s sign-off wait for every review note to be cleared, and a note raised or opened again takes them back. The engagement partner is one of the practice’s owners.</p>
      </div>

      <div className="panel panel-pad stack-sm">
        <strong className="small">Review notes</strong>
        {f.notes.length === 0 && <p className="small muted">None yet.</p>}
        {f.notes.map((n) => (
          <div key={n.id} className="stack-sm" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }} data-private>
            <span className="small">
              {n.account && <strong>{`${n.account.code} ${n.account.name ?? ''}: `}</strong>}
              {n.text} <span className="xs muted">({n.raisedBy}, {day(n.raisedAt)})</span>
            </span>
            {n.replies.map((r, i) => (
              <span key={i} className="small" style={{ paddingLeft: 12 }}>
                {r.text} <span className="xs muted">({r.by}, {day(r.at)})</span>
              </span>
            ))}
            <div className="row wrap" style={{ gap: 6 }}>
              {n.cleared ? (
                <span className="xs muted grow">
                  Cleared by {n.cleared.by}, {day(n.cleared.at)}.
                </span>
              ) : (
                writes && (
                  <>
                    <input className="input grow" placeholder="Your answer" value={reply[n.id] ?? ''} maxLength={4000} onChange={(e) => setReply({ ...reply, [n.id]: e.target.value })} />
                    <button
                      className="btn small"
                      disabled={busy !== null || !(reply[n.id] ?? '').trim()}
                      onClick={() =>
                        void act(`reply-${n.id}`, async () => {
                          await api(`${base}/file/notes/${n.id}/replies`, { body: { text: reply[n.id] } });
                          setReply({ ...reply, [n.id]: '' });
                        })
                      }
                    >
                      Answer
                    </button>
                  </>
                )
              )}
              {writes && (n.mine || f.owner) && (
                <button
                  className="btn small quiet"
                  disabled={busy !== null}
                  onClick={() => {
                    if (n.cleared && given && !confirm('Open this note again? The year’s Reviewed and Engagement partner sign-offs are taken back: whoever gives them signs again once it’s cleared.')) return;
                    void act(`clear-${n.id}`, () => api<{ removed?: Signoff[] }>(`${base}/file/notes/${n.id}/clear`, { body: { cleared: !n.cleared } }), (r) => (n.cleared ? `Opened again${removedWords(r.removed)}` : 'Cleared'));
                  }}
                >
                  {n.cleared ? 'Open it again' : 'Clear it'}
                </button>
              )}
            </div>
          </div>
        ))}
        {writes && (
          <form
            className="stack-sm"
            style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (given && !confirm('Raise this note? The year’s Reviewed and Engagement partner sign-offs are taken back: whoever gives them signs again once it’s cleared.')) return;
              const line = f.lines?.find((l) => l.accountId === note.account);
              void act(
                'note',
                async () => {
                  const r = await api<{ removed?: Signoff[] }>(`${base}/file/notes`, { body: { fyEnd: f.fyEnd, account: line ? { code: line.code, name: line.name } : null, text: note.text } });
                  setNote({ account: '', text: '' });
                  return r;
                },
                (r) => `Note raised${removedWords(r.removed)}`,
              );
            }}
          >
            {f.lines && (
              <Field label="On">
                {(p) => (
                  <select {...p} className="select" value={note.account} onChange={(e) => setNote({ ...note, account: e.target.value })}>
                    <option value="">The year as a whole</option>
                    {f.lines!.map((l) => (
                      <option key={l.accountId} value={l.accountId}>
                        {l.code} {l.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            <Field label="A new review note">{(p) => <textarea {...p} className="input" rows={2} maxLength={4000} value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} />}</Field>
            <div>
              <button className="btn small" disabled={busy !== null || !note.text.trim()}>
                Raise it
              </button>
            </div>
          </form>
        )}
      </div>

      {f.lines ? (
        <div className="panel" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Account at the year end</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
                <th>Prepared</th>
                <th>Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {f.lines.map((l) => (
                <tr key={l.accountId}>
                  <td data-private>
                    {l.code} {l.name}
                  </td>
                  <td className="num">{l.debitCents ? <Money cents={l.debitCents} /> : ''}</td>
                  <td className="num">{l.creditCents ? <Money cents={l.creditCents} /> : ''}</td>
                  {(['prepared', 'reviewed'] as const).map((which) => {
                    const t = l[which];
                    const may = writes && (which === 'reviewed' || f.level === 'books');
                    return (
                      <td key={which} className="xs">
                        <label className="check" style={{ gap: 4 }}>
                          <input
                            type="checkbox"
                            checked={Boolean(t)}
                            disabled={!may || busy !== null}
                            onChange={(e) => void act(`${which}-${l.accountId}`, () => api(`${base}/file/ticks`, { body: { fyEnd: f.fyEnd, accountId: l.accountId, which, on: e.target.checked } }))}
                          />
                          <span data-private>
                            {t ? `${t.by}, ${day(t.at)}` : ''}
                            {t?.changed && <span className="warn-text"> (balance changed since)</span>}
                            {which === 'reviewed' && t?.samePerson && <span className="muted"> (who prepared it)</span>}
                          </span>
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {f.totals && (
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th className="num">
                    <Money cents={f.totals.debitCents} />
                  </th>
                  <th className="num">
                    <Money cents={f.totals.creditCents} />
                  </th>
                  <th colSpan={2} className={f.totals.differenceCents ? 'warn-text xs' : 'xs muted'}>
                    {f.totals.differenceCents ? (
                      <>
                        Doesn’t balance: <Money cents={f.totals.differenceCents} />
                      </>
                    ) : (
                      'Debits and credits agree'
                    )}
                  </th>
                </tr>
              </tfoot>
            )}
          </table>
          {f.gone.length > 0 && <p className="xs muted panel-pad">Ticked before, with no balance at the year end now: {f.gone.map((g) => `${g.code} ${g.name}`).join(', ')}.</p>}
        </div>
      ) : (
        <p className="small muted">Their books are on their own Shap, so their trial balance isn’t here to tick: review notes and the year’s sign-offs are.</p>
      )}
    </section>
  );
}

function NewLetter({ base, years, coming, pocket, onClose, onDone }: { base: string; years: string[]; coming: string[]; pocket: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [services, setServices] = useState<Service[]>(['compile']);
  // The year ends a new letter can start from: this year's and the next, and the last three ended.
  const choices = [...new Set([...coming, ...years.slice(0, 3)])];
  const [from, setFrom] = useState(years[0] ?? coming[coming.length - 1] ?? '');
  const [other, setOther] = useState('');
  const [fees, setFees] = useState('');
  const [body, setBody] = useState('');
  const [registered, setRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  const offered = SERVICES.filter((s) => s !== 'books' || !pocket);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`${base}/letters`, { body: { services, other, fromYearEnd: from, fees, body, registered } });
      toast('Drafted: read it, and change the words as you like');
      onDone();
      onClose();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
      setBusy(false);
    }
  };
  return (
    <Drawer title="A new engagement letter" sub="Drafted from the client’s details in Shap: you read it and change it before you send it." onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <div className="stack-sm">
          <strong className="small">What your practice will do for them</strong>
          {offered.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={services.includes(s)} onChange={(e) => setServices(e.target.checked ? [...services, s] : services.filter((x) => x !== s))} />
              <span className="small">
                {SERVICE_WORDS[s]}
                {s === 'accounting_officer' ? ' (a close corporation only)' : ''}
              </span>
            </label>
          ))}
          {pocket && <span className="xs muted">They keep their books in Shap Pocket and write them up themselves, so writing up the books isn’t offered.</span>}
        </div>
        <Field label="Anything else">{(p) => <input {...p} className="input" maxLength={2000} value={other} onChange={(e) => setOther(e.target.value)} />}</Field>
        <Field label="From the year ending">
          {(p) => (
            <select {...p} className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
              {choices.map((y) => (
                <option key={y} value={y}>
                  {formatDate(y)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Fees (as the letter says them)">{(p) => <textarea {...p} className="input" rows={2} maxLength={2000} value={fees} onChange={(e) => setFees(e.target.value)} />}</Field>
        <Field label="Your professional body (for its code of conduct)">{(p) => <input {...p} className="input" maxLength={200} placeholder="e.g. SAICA, SAIPA" value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        {services.some((s) => s === 'payroll' || s === 'vat' || s === 'income_tax') && (
          <label className="check">
            <input type="checkbox" checked={registered} onChange={(e) => setRegistered(e.target.checked)} />
            <span className="small">Those of us who prepare returns or advise on tax are registered tax practitioners, or work under one’s direct supervision (Tax Administration Act, section 240): the letter says so only if you tick this.</span>
          </label>
        )}
        <p className="xs muted">{LETTER_NOTE}</p>
        <div>
          <button className="btn primary" disabled={busy || (!services.length && !other.trim()) || !from}>
            {busy ? 'Drafting…' : 'Draft it'}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

function EditLetter({ base, letter, onClose, onDone }: { base: string; letter: Letter; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [body, setBody] = useState<Section[]>(letter.body.map((s) => ({ ...s, paragraphs: [...s.paragraphs] })));
  const [parties, setParties] = useState<Parties>({ practiceName: letter.practiceName, practiceReg: letter.practiceReg, practiceTrading: letter.practiceTrading, practiceAddress: letter.practiceAddress, clientName: letter.clientName });
  const [busy, setBusy] = useState(false);
  const party = (k: keyof Parties) => (e: { target: { value: string } }) => setParties({ ...parties, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      await api(`${base}/letters/${letter.id}`, { method: 'PUT', body: { body: body.map((s) => ({ heading: s.heading, paragraphs: s.paragraphs.filter((p) => p.trim()) })), parties } });
      toast('Saved');
      onDone();
      onClose();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
      setBusy(false);
    }
  };
  return (
    <Drawer
      wide
      title="The letter’s words"
      sub="Change anything while it’s a draft: once it’s marked as sent, its words and parties are kept as they are."
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={busy || !parties.practiceName.trim() || !parties.clientName.trim()} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <div className="stack">
        <p className="xs muted">{LETTER_NOTE}</p>
        <div className="stack-sm">
          <strong className="small">The parties, as the letter names them</strong>
          <Field label="Your practice’s legal name">{(p) => <input {...p} className="input" maxLength={200} value={parties.practiceName} onChange={party('practiceName')} required />}</Field>
          <Field label="Its registration number">{(p) => <input {...p} className="input" maxLength={60} value={parties.practiceReg} onChange={party('practiceReg')} />}</Field>
          <Field label="Trading as">{(p) => <input {...p} className="input" maxLength={200} value={parties.practiceTrading} onChange={party('practiceTrading')} />}</Field>
          <Field label="Its address">{(p) => <textarea {...p} className="input" rows={2} maxLength={500} value={parties.practiceAddress} onChange={party('practiceAddress')} />}</Field>
          <Field label="The client (its legal name)">{(p) => <input {...p} className="input" maxLength={200} value={parties.clientName} onChange={party('clientName')} required />}</Field>
        </div>
        {body.map((s, i) => (
          <div key={i} className="stack-sm">
            <input className="input strong" value={s.heading} maxLength={200} onChange={(e) => setBody(body.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)))} />
            <textarea
              className="input"
              rows={Math.min(14, 2 + s.paragraphs.join('\n\n').length / 80)}
              maxLength={40 * 4000}
              value={s.paragraphs.join('\n\n')}
              onChange={(e) => setBody(body.map((x, j) => (j === i ? { ...x, paragraphs: e.target.value.split(/\n{2,}/) } : x)))}
            />
            <div>
              <button type="button" className="btn small quiet" onClick={() => setBody(body.filter((_, j) => j !== i))}>
                Take out this part
              </button>
            </div>
          </div>
        ))}
        <div>
          <button type="button" className="btn small" onClick={() => setBody([...body, { heading: 'A new part', paragraphs: [''] }])}>
            Add a part
          </button>
        </div>
      </div>
    </Drawer>
  );
}

/** A signed copy as it goes up: a photo shrunk and re-encoded (which also leaves out where and on what it was taken), a PDF as it is. */
async function signedCopy(file: globalThis.File): Promise<{ filename: string; mime: string; dataBase64: string }> {
  if (file.type === 'application/pdf') return { filename: file.name, mime: file.type, dataBase64: await fileToBase64(file) };
  const blob = await squeezePhoto(file, { pixels: 2_000_000, quality: 0.75 });
  return { filename: file.name.replace(/\.\w+$/, '') + '.jpg', mime: 'image/jpeg', dataBase64: await fileToBase64(blob) };
}

function AcceptLetter({ base, letter, onClose, onDone }: { base: string; letter: Letter; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [on, setOn] = useState(todayIso());
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [how, setHow] = useState<AcceptedHow>('signed');
  const [picked, setPicked] = useState<globalThis.File | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const signed = how === 'signed' && picked ? await signedCopy(picked) : undefined;
      if (signed && (signed.dataBase64.length * 3) / 4 > SIGNED_MAX) {
        toast('That file is too big (6 MB at most): a PDF of fewer pages, or a photo, is smaller.', 'error');
        setBusy(false);
        return;
      }
      await api(`${base}/letters/${letter.id}/accept`, { body: { on, name, capacity, how, signed } });
      toast('Recorded as accepted');
      onDone();
      onClose();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
      setBusy(false);
    }
  };
  return (
    <Drawer title="Their acceptance" sub="Who accepted the letter for the client, and when: with the signed copy, or recorded." onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <Field label="Accepted on">{(p) => <input {...p} className="input" type="date" value={on} min={letter.sentAt?.slice(0, 10)} max={todayIso()} onChange={(e) => setOn(e.target.value)} required />}</Field>
        <Field label="By (their name)">{(p) => <input {...p} className="input" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
        <Field label="As (director, member, partner, trustee or owner)">{(p) => <input {...p} className="input" maxLength={200} value={capacity} onChange={(e) => setCapacity(e.target.value)} />}</Field>
        <div className="stack-sm">
          {ACCEPTED_HOW.map((h) => (
            <label key={h} className="check">
              <input type="radio" name="how" checked={how === h} onChange={() => setHow(h)} />
              <span className="small">{h === 'signed' ? 'They signed it: upload the signed copy (a PDF or a photo)' : 'Record it without a signed copy (they accepted by email, say)'}</span>
            </label>
          ))}
        </div>
        {how === 'signed' && (
          <>
            <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />
            <span className="xs muted">A photo is made smaller before it goes up; a PDF goes up as it is (6 MB at most).</span>
          </>
        )}
        <div>
          <button className="btn primary" disabled={busy || !name.trim() || (how === 'signed' && !picked)}>
            {busy ? 'Saving…' : 'Record it'}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

/** Ended in Shap, with the last year it covers (the practice's record; the engagement ends as the letter says). */
function EndLetter({ base, letter, years, onClose, onDone }: { base: string; letter: Letter; years: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const accepted = letter.status === 'accepted';
  // Its own first year, every later one that has ended, and the one under way.
  const choices = [...new Set([...years.filter((y) => y && y >= letter.fromYearEnd), letter.fromYearEnd])].sort().reverse();
  const [last, setLast] = useState<string>(accepted ? (choices[0] ?? '') : '');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`${base}/letters/${letter.id}/end`, { body: { lastYearEnd: last || null } });
      toast('Ended in Shap');
      onDone();
      onClose();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      toast(err instanceof ApiError ? err.message : UNEXPECTED, 'error');
      setBusy(false);
    }
  };
  return (
    <Drawer title="End this letter" sub={LETTER_END_CONFIRM} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        {accepted ? (
          <Field label="The last year it covers">
            {(p) => (
              <select {...p} className="select" value={last} onChange={(e) => setLast(e.target.value)}>
                {choices.map((y) => (
                  <option key={y} value={y}>
                    The year to {formatDate(y)}
                  </option>
                ))}
                <option value="">None: it ended before its first year</option>
              </select>
            )}
          </Field>
        ) : (
          <p className="small muted">It was sent but never accepted, so it covers no year.</p>
        )}
        <p className="xs muted">The letter is kept, as it was. Years it covers still show it in their working papers.</p>
        <div>
          <button className="btn primary" disabled={busy}>
            {busy ? 'Ending…' : 'End it'}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
