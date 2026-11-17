/**
 * Practice → a client → Working papers (docs/ACCOUNTANT.md, "Engagement letters and working
 * papers"): the practice's engagement letters with the client, and its working papers for each of
 * the client's ended years (review notes, the trial balance ticked as prepared and reviewed, and the
 * year's sign-offs). The practice's own record, on its server (server modules/working-papers.ts):
 * checks for the practitioner, never locks.
 */
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { ACCEPTED_HOW, FILE_NOTE, formatDate, LETTER_NOTE, SERVICE_WORDS, SERVICES, SIGNOFF_WORDS, SIGNOFFS, todayIso, type AcceptedHow, type Level, type LetterStatus, type Service, type Signoff } from '@shap/shared';
import { PageHead } from '../components/Shell';
import { Drawer, ErrorBox, Field, Loading, Money, useToast } from '../components/ui';
import { api, apiUrl, ApiError } from '../lib/api';
import { fileToBase64 } from '../lib/files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import { UNEXPECTED } from '../lib/words';

interface Section {
  heading: string;
  paragraphs: string[];
}
interface Letter {
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
  signedName: string | null;
  years: { fyEnd: string; by: string | null; at: string }[];
}
interface Tick {
  by: string;
  at: string;
  changed: boolean;
  samePerson?: boolean;
}
interface File {
  client: { id: string; name: string; kind: string; archived: boolean };
  level: Level;
  owner: boolean;
  years: string[];
  fyEnd: string;
  ticksHere: boolean;
  letter: { accepted: boolean; compiling: boolean; termsLooked: boolean };
  lines: { code: string; name: string; balanceCents: number; prepared: Tick | null; reviewed: Tick | null }[] | null;
  gone: { code: string; name: string }[];
  notes: { id: string; account: { code: string; name: string | null } | null; text: string; raisedBy: string; raisedAt: string; mine: boolean; cleared: { by: string; at: string } | null; replies: { text: string; by: string; at: string }[] }[];
  signoffs: Record<Signoff, { by: string; mine: boolean; at: string; changed: boolean } | null>;
}

const day = (at: string | null | undefined) => (at ? formatDate(at.slice(0, 10)) : '');
const STATUS_WORDS: Record<LetterStatus, string> = { draft: 'Draft', sent: 'Sent, not accepted yet', accepted: 'Accepted', ended: 'Ended' };

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
  const [note, setNote] = useState({ account: '', text: '' });
  const [reply, setReply] = useState<Record<string, string>>({});

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      await Promise.all([file.reload(), letters.reload()]);
      if (done) toast(done);
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
  const open = f.notes.filter((n) => !n.cleared).length;
  const writes = !f.client.archived;

  return (
    <div className="stack-lg">
      <PageHead title={<span data-private>{f.client.name}</span>} sub="Working papers and engagement letters" back={{ to: '/practice', label: 'Practice' }} />
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
                        l.endedAt ? `ended ${day(l.endedAt)}` : '',
                      ]
                        .filter(Boolean)
                        .join('; ')}
                      .
                    </span>
                  </span>
                  <span className="row wrap" style={{ gap: 6 }}>
                    <a className="btn small quiet" href={apiUrl(`${base}/letters/${l.id}/pdf`)}>
                      PDF
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
                        <button className="btn small" disabled={busy !== null} onClick={() => void act(`sent-${l.id}`, () => api(`${base}/letters/${l.id}/sent`, { body: {} }), 'Marked as sent')}>
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
                    {manage && (l.status === 'sent' || l.status === 'accepted') && (
                      <button
                        className="btn small quiet"
                        disabled={busy !== null}
                        onClick={() => {
                          if (confirm('End this letter? It’s kept, as it was; a new letter takes its place.')) void act(`end-${l.id}`, () => api(`${base}/letters/${l.id}/end`, { body: {} }), 'Ended');
                        }}
                      >
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
          <p className="xs muted">Reviewed and the engagement partner’s sign-off wait for every review note to be cleared. The engagement partner is one of the practice’s owners.</p>
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
                  <button className="btn small quiet" disabled={busy !== null} onClick={() => void act(`clear-${n.id}`, () => api(`${base}/file/notes/${n.id}/clear`, { body: { cleared: !n.cleared } }), n.cleared ? 'Opened again' : 'Cleared')}>
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
                const line = f.lines?.find((l) => l.code === note.account);
                void act(
                  'note',
                  async () => {
                    await api(`${base}/file/notes`, { body: { fyEnd: f.fyEnd, account: line ? { code: line.code, name: line.name } : null, text: note.text } });
                    setNote({ account: '', text: '' });
                  },
                  'Note raised',
                );
              }}
            >
              {f.lines && (
                <Field label="On">
                  {(p) => (
                    <select {...p} className="select" value={note.account} onChange={(e) => setNote({ ...note, account: e.target.value })}>
                      <option value="">The year as a whole</option>
                      {f.lines!.map((l) => (
                        <option key={l.code} value={l.code}>
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
                  <th className="num">Balance</th>
                  <th>Prepared</th>
                  <th>Reviewed</th>
                </tr>
              </thead>
              <tbody>
                {f.lines.map((l) => (
                  <tr key={l.code}>
                    <td data-private>
                      {l.code} {l.name}
                    </td>
                    <td className="num">
                      <Money cents={l.balanceCents} />
                    </td>
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
                              onChange={(e) => void act(`${which}-${l.code}`, () => api(`${base}/file/ticks`, { body: { fyEnd: f.fyEnd, code: l.code, which, on: e.target.checked } }))}
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
            </table>
            {f.gone.length > 0 && <p className="xs muted panel-pad">Ticked before, with no balance at the year end now: {f.gone.map((g) => `${g.code} ${g.name}`).join(', ')}.</p>}
          </div>
        ) : (
          <p className="small muted">Their books are on their own Shap, so their trial balance isn’t here to tick: review notes and the year’s sign-offs are.</p>
        )}
      </section>

      {newLetter && <NewLetter base={base} years={f.years} onClose={() => setNewLetter(false)} onDone={() => void Promise.all([letters.reload(), file.reload()])} />}
      {editing && <EditLetter base={base} letter={editing} onClose={() => setEditing(null)} onDone={() => void letters.reload()} />}
      {accepting && <AcceptLetter base={base} letter={accepting} onClose={() => setAccepting(null)} onDone={() => void Promise.all([letters.reload(), file.reload()])} />}
    </div>
  );
}

/** The year ends a new letter can start from: the ended ones, and the two after the latest. */
function startYears(years: string[]): string[] {
  const latest = years[0];
  if (!latest) return [];
  const next = (d: string) => `${Number(d.slice(0, 4)) + 1}${d.slice(4, 7)}-${new Date(Date.UTC(Number(d.slice(0, 4)) + 1, Number(d.slice(5, 7)), 0)).getUTCDate()}`;
  return [next(next(latest)), next(latest), ...years.slice(0, 3)];
}

function NewLetter({ base, years, onClose, onDone }: { base: string; years: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [services, setServices] = useState<Service[]>(['compile']);
  const choices = startYears(years);
  const [from, setFrom] = useState(years[0] ?? choices[0] ?? '');
  const [other, setOther] = useState('');
  const [fees, setFees] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`${base}/letters`, { body: { services, other, fromYearEnd: from, fees, body } });
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
          {SERVICES.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={services.includes(s)} onChange={(e) => setServices(e.target.checked ? [...services, s] : services.filter((x) => x !== s))} />
              <span className="small">
                {SERVICE_WORDS[s]}
                {s === 'accounting_officer' ? ' (a close corporation only)' : ''}
              </span>
            </label>
          ))}
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
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`${base}/letters/${letter.id}`, { method: 'PUT', body: { body: body.map((s) => ({ heading: s.heading, paragraphs: s.paragraphs.filter((p) => p.trim()) })) } });
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
      sub="Change anything: once it’s marked as sent, it’s kept as it is."
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <div className="stack">
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
      const signed = how === 'signed' && picked ? { filename: picked.name, mime: picked.type, dataBase64: await fileToBase64(picked) } : undefined;
      await api(`${base}/letters/${letter.id}/accept`, { body: { on, name, capacity, how, signed } });
      toast('Accepted');
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
        <Field label="Accepted on">{(p) => <input {...p} className="input" type="date" value={on} max={todayIso()} onChange={(e) => setOn(e.target.value)} required />}</Field>
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
        {how === 'signed' && <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />}
        <div>
          <button className="btn primary" disabled={busy || !name.trim() || (how === 'signed' && !picked)}>
            {busy ? 'Saving…' : 'Record it'}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
