/**
 * Shap Accountant from setup (docs/ACCOUNTANT.md, "Setting up a practice"): the server's part (each
 * client's books are a database of their own, so this Shap's database login must be allowed to make
 * them: setup checks while the owner answers, and once the terms are accepted at the end, asks shap-ctl
 * where it looks after a server of the practice's own), and the practice's people (solo, or a sign-in
 * each on a profile, now or later). The server's part shows on Practice too, while it isn't ready.
 */
import { useEffect, useRef, useState } from 'react';
import { passwordProblem, PRACTICE_OWN_SERVER, SERVER_NOT_MANAGED, TEAM_MAX, withNeeds, type Feature, type Task } from '@shap/shared';
import { AccessTicks } from './People';
import { Field, Icon } from './ui';
import { api, ApiError } from '../lib/api';

export interface ServerState {
  ready: boolean;
  login: string;
  managed: boolean;
  pending: boolean;
  /** What shap-ctl said when last asked; `shared`: it found a real company added to the server. */
  asked: { at: string; ok: boolean; message: string; shared: boolean } | null;
  otherCompanies: boolean;
  testServer: boolean;
  /** Someone besides the owner signs in already (a test server wiped and set up again): the team is added in Settings. */
  othersSignIn: boolean;
}

/** Other companies' books share the server (a test server's are made up): Shap Accountant doesn't belong here. */
export const sharedServer = (s: ServerState) => s.otherCompanies && !s.testServer;
/** Shap may ask shap-ctl for it: it looks after this server, which is the practice's alone, and nothing's waiting. */
export const mayAsk = (s: ServerState) => !s.ready && s.managed && !sharedServer(s) && !s.pending;

/** How long before saying the server is taking long (it usually answers in seconds; behind an update, minutes). */
const WAIT_MS = 2 * 60 * 1000;
/** While the server is busy with another request, Shap asks again this often (the route allows 5 a minute). */
const ASK_EVERY_MS = 15_000;

/** The server's state, looked at again every few seconds while shap-ctl has the request (or is busy). */
export function usePracticeServer() {
  const [state, setState] = useState<ServerState | null>(null);
  const [error, setError] = useState('');
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const since = useRef(0);
  const busyRef = useRef(false);
  const lastAsk = useRef(0);
  const request = async () => {
    setError('');
    since.current = since.current || Date.now();
    lastAsk.current = Date.now();
    try {
      setState(await api<ServerState>('/api/practice/server', { body: {} }));
      busyRef.current = false;
      setBusy(false);
    } catch (err) {
      // Busy with another request: asked again once it's done, at most every ASK_EVERY_MS (below).
      if (err instanceof ApiError && err.code === 'ctl_busy') {
        busyRef.current = true;
        setBusy(true);
      } else setError(err instanceof ApiError ? err.message : 'Couldn’t ask the server');
    }
    setTick((t) => t + 1);
  };
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      try {
        const s = await api<ServerState>('/api/practice/server');
        if (stop) return;
        setState(s);
        if (busyRef.current && mayAsk(s) && Date.now() - lastAsk.current >= ASK_EVERY_MS) return void (await request());
        const waiting = !s.ready && (s.pending || busyRef.current);
        if (waiting && since.current && Date.now() - since.current > WAIT_MS) setSlow(true);
        if (waiting && !stop) timer = setTimeout(() => void look(), 3000);
      } catch (err) {
        if (!stop) setError(err instanceof ApiError ? err.message : 'Couldn’t reach the server');
      }
    };
    void look();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  return { state, error, slow, busy, request };
}

/**
 * What the server can do for Shap Accountant, in words that are true in each state it can be in: on
 * setup's practice step (it only looks: the asking is at the end, once the terms are accepted), and
 * on Practice for the owner while it isn't ready (with the button to ask), or isn't the practice's alone.
 */
export function PracticeServer({ where, onState }: { where: 'setup' | 'practice'; onState?: (s: ServerState) => void }) {
  const { state, error, slow, busy, request } = usePracticeServer();
  useEffect(() => {
    if (state) onState?.(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  if (!state) return error ? <div className="banner alert small">{error}</div> : <p className="xs muted">Looking at this server…</p>;
  const shared = sharedServer(state);
  if (where === 'practice' && state.ready && !shared) return null;
  // A refusal because of other companies that are gone since (the server's next count): as if never asked.
  const failed = !state.ready && !state.pending && !busy && state.asked && !state.asked.ok && !(state.asked.shared && !state.otherCompanies);
  let head: string;
  let body: string;
  let command = false;
  let ask: string | null = null;
  if (shared) {
    head = 'Other companies’ books are on this server too';
    body = state.ready
      ? `Shap can still make clients’ databases here. ${PRACTICE_OWN_SERVER}`
      : `${PRACTICE_OWN_SERVER} Here, this Shap’s database login can’t make databases, so your clients’ books can’t be kept on this server.`;
  } else if (state.ready) {
    head = 'Shap can make your clients’ databases here';
    body = state.testServer
      ? 'A test server: try Shap Accountant here with made-up clients only (10 at most). Each client you add gets a database of its own on this server.'
      : 'Each client you add gets a database of its own on this server. The server’s security, its backups, and who in your practice opens which books are your practice’s to look after.';
  } else if (state.testServer) {
    head = 'This test server can’t make its clients’ databases yet';
    body = 'Whoever runs the server can let it make its made-up clients’ databases (docs/TEST_SERVER.md, on Shap’s GitHub):';
    command = true;
  } else if (!state.managed) {
    head = 'Shap can’t make your clients’ databases here yet';
    body = SERVER_NOT_MANAGED;
    command = true;
  } else if (state.pending || busy) {
    head = 'Asking the server to let Shap make your clients’ databases…';
    body = busy
      ? 'The server is busy with another request (a check, an update or a backup): Shap asks once it’s done.'
      : slow
        ? where === 'setup'
          ? 'The server hasn’t answered yet. Carry on: Practice shows this until it has.'
          : 'The server hasn’t answered yet: this goes once it has.'
        : 'It usually takes a few seconds.';
  } else if (failed && state.asked!.shared && state.otherCompanies) {
    // shap-ctl found a real company added to the server: Shap Accountant doesn't belong there.
    head = 'Other companies’ books are on this server too';
    body = `The server said: ${state.asked!.message}`;
  } else if (failed) {
    head = 'The server didn’t let Shap make your clients’ databases';
    body = `The server said: ${state.asked!.message} Whoever runs the server can allow it by hand (docs/ACCOUNTANT.md, on Shap’s GitHub):`;
    command = true;
    // In setup Shap Accountant isn't on yet: it asks again at the end, once the terms are accepted.
    if (where === 'setup') body = `The server said: ${state.asked!.message} When you accept the terms at the end, Shap asks the server again. Whoever runs the server can also allow it by hand (docs/ACCOUNTANT.md, on Shap’s GitHub):`;
    else ask = 'Ask the server again';
  } else {
    head = 'Shap can’t make your clients’ databases here yet';
    body =
      where === 'setup'
        ? 'When you accept the terms at the end, Shap asks the server to let this Shap’s database login make databases, and nothing more.'
        : 'Shap can ask the server to let this Shap’s database login make them, and nothing more.';
    ask = where === 'practice' ? 'Ask the server' : null;
  }
  return (
    <div className={`panel panel-pad stack ${state.ready && !shared ? '' : 'banner'}`} style={{ gap: 8 }}>
      <strong className="small">{head}</strong>
      <span className="xs muted">{body}</span>
      {command && state.login && (
        <span className="xs muted">
          For whoever runs the server: <code>alter role "{state.login}" createdb;</code>
        </span>
      )}
      {ask && (
        <button type="button" className="btn small start" onClick={() => void request()}>
          {ask}
        </button>
      )}
      {error && <div className="banner alert small">{error}</div>}
    </div>
  );
}

/** At the end of setup, once the terms are accepted: asks shap-ctl where it may (Practice follows it). Never stops setup. */
export async function askServerIfNeeded(s: ServerState | null): Promise<void> {
  if (!s || !mayAsk(s)) return;
  await api('/api/practice/server', { body: {} }).catch(() => undefined);
}

/* ------------------------------------------------------------------ the practice's people */

export interface TeamProfile {
  name: string;
  access: Task[];
  hint?: string;
}
export interface TeamPerson {
  name: string;
  email: string;
  profile: string;
  password: string;
}
export interface Team {
  /** Just the owner, or the owner and staff. */
  who: 'solo' | 'staff' | null;
  /** Staff: add their sign-ins now, or later under Settings → People who sign in. */
  now: boolean | null;
  profiles: TeamProfile[];
  people: TeamPerson[];
}

const WORDS = 'abcdefghjkmnpqrstuvwxyz23456789';
/** A starting password, for the owner to pass on: four groups of four, nothing easily misread. */
export function startingPassword(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => WORDS[b % WORDS.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

/** What's wrong with the team as it stands, for the step's Next (null: nothing). */
export function teamProblem(t: Team, ownerEmail: string): string | null {
  if (!t.who) return 'Say who works in your practice';
  if (t.who === 'solo') return null;
  if (t.now === null) return 'Choose: add them now, or later';
  if (!t.now) return null;
  const names = t.profiles.map((p) => p.name.trim().toLowerCase());
  if (names.some((n) => !n)) return 'Give each profile a name';
  if (new Set(names).size !== names.length) return 'Two profiles have the same name';
  if (!t.people.length) return 'Add someone, or add them later';
  const emails = t.people.map((p) => p.email.trim().toLowerCase());
  for (const p of t.people) {
    if (!p.name.trim()) return 'Each person needs a name';
    if (!looksLikeEmail(p.email)) return `Enter ${p.name.trim() || 'everyone'}’s email`;
    if (!names.includes(p.profile.trim().toLowerCase())) return `Choose a profile for ${p.name.trim()}`;
    const pw = passwordProblem(p.password, p);
    if (pw) return `${p.name.trim()}’s starting password: ${pw.replace('your name and email', 'their name and email')}`;
  }
  if (new Set(emails).size !== emails.length) return 'Two people have the same email: each signs in with their own';
  if (emails.includes(ownerEmail.trim().toLowerCase())) return 'That’s your own email: each person signs in with theirs';
  return null;
}

/** The team as the server takes it (POST /api/practice/team). */
export const teamBody = (t: Team) => ({
  profiles: t.profiles.map((p) => ({ name: p.name.trim(), access: withNeeds(p.access) })),
  people: t.people.map((p) => ({ name: p.name.trim(), email: p.email.trim().toLowerCase(), profile: p.profile.trim(), password: p.password })),
});

export function PracticeTeam({ team, onChange, has, othersSignIn }: { team: Team; onChange: (t: Team) => void; has: (f: Feature) => boolean; othersSignIn?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const set = (patch: Partial<Team>) => onChange({ ...team, ...patch });
  /** The people, as many as said (the ones already filled in kept). */
  const sized = (n: number) => {
    const count = Math.max(1, Math.min(TEAM_MAX, Math.round(n) || 1));
    const people = team.people.slice(0, count);
    while (people.length < count) people.push({ name: '', email: '', profile: team.profiles[0]?.name ?? '', password: startingPassword() });
    return people;
  };
  const person = (i: number, patch: Partial<TeamPerson>) => set({ people: team.people.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const profile = (i: number, patch: Partial<TeamProfile>) => {
    const was = team.profiles[i]!.name;
    const profiles = team.profiles.map((p, j) => (j === i ? { ...p, ...patch } : p));
    // A renamed profile keeps its people.
    const people = patch.name !== undefined ? team.people.map((p) => (p.profile === was ? { ...p, profile: patch.name! } : p)) : team.people;
    set({ profiles, people });
  };
  const copy = async () => {
    const lines = team.people.map((p) => `${p.name.trim()}: ${p.email.trim()} · starting password ${p.password}`);
    try {
      await navigator.clipboard.writeText(`Shap sign-ins (${location.origin})\n${lines.join('\n')}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="stack">
      <div className="choice-grid">
        <button type="button" className={`choice ${team.who === 'solo' ? 'on' : ''}`} aria-pressed={team.who === 'solo'} onClick={() => set({ who: 'solo' })}>
          <strong>Just me</strong>
          <span className="xs muted">A solo practitioner: only you sign in.</span>
        </button>
        <button type="button" className={`choice ${team.who === 'staff' ? 'on' : ''}`} aria-pressed={team.who === 'staff'} onClick={() => set({ who: 'staff', people: sized(team.people.length || 1) })}>
          <strong>Me and my staff</strong>
          <span className="xs muted">Each signs in as themselves, and does what their profile allows.</span>
        </button>
      </div>
      {team.who === 'staff' && (
        <>
          <Field label="How many staff?" hint={`Not counting you. Up to ${TEAM_MAX} here; more later.`}>
            {(p) => <input {...p} className="input" type="number" min={1} max={TEAM_MAX} value={team.people.length || 1} onChange={(e) => set({ people: sized(Number(e.target.value)) })} style={{ width: 100 }} />}
          </Field>
          {othersSignIn && <p className="xs muted">Others sign in here already, so add your team under Settings → People who sign in, once you’re set up.</p>}
          <div className="choice-grid">
            <button type="button" className={`choice small ${team.now === true ? 'on' : ''}`} aria-pressed={team.now === true} disabled={othersSignIn} onClick={() => set({ now: true })}>
              Add their sign-ins now
            </button>
            <button type="button" className={`choice small ${team.now === false ? 'on' : ''}`} aria-pressed={team.now === false} onClick={() => set({ now: false })}>
              Later, under Settings → People who sign in
            </button>
          </div>
        </>
      )}
      {team.who === 'staff' && team.now && (
        <>
          <div className="stack-sm">
            <strong className="small">Profiles: what each kind of staff may do</strong>
            <p className="xs muted">Change any of them, or add your own. Which clients each person opens, and whether they write up the books or compile the statements, is chosen per client on the Practice page (Who opens it).</p>
            {team.profiles.map((p, i) => (
              <div key={i} className="panel panel-pad stack" style={{ gap: 8 }}>
                <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                  <Field label="Profile" className="grow">
                    {(f) => <input {...f} className="input" value={p.name} maxLength={60} onChange={(e) => profile(i, { name: e.target.value })} />}
                  </Field>
                  <button type="button" className="btn quiet small" onClick={() => setOpen(open === i ? null : i)}>
                    {open === i ? 'Done' : 'What they may do ▸'}
                  </button>
                  {!team.people.some((x) => x.profile === p.name) && team.profiles.length > 1 && (
                    <button type="button" className="btn quiet small danger" onClick={() => set({ profiles: team.profiles.filter((_, j) => j !== i) })}>
                      Remove
                    </button>
                  )}
                </div>
                {p.hint && open !== i && <span className="xs muted">{p.hint}</span>}
                {open === i && <AccessTicks value={p.access} onChange={(access) => profile(i, { access })} has={has} />}
              </div>
            ))}
            <button type="button" className="btn quiet small start" onClick={() => (set({ profiles: [...team.profiles, { name: '', access: [] }] }), setOpen(team.profiles.length))}>
              <Icon name="plus" size={16} /> Add a profile
            </button>
          </div>
          <div className="stack-sm">
            <strong className="small">Their sign-ins</strong>
            {team.people.map((p, i) => {
              const pw = p.password ? passwordProblem(p.password, p)?.replace('your name and email', 'their name and email') : 'At least 10 characters';
              return (
                <div key={i} className="panel panel-pad form-grid" data-private>
                  <Field label="Name">{(f) => <input {...f} className="input" value={p.name} maxLength={100} onChange={(e) => person(i, { name: e.target.value })} />}</Field>
                  <Field label="Email (they sign in with this)">{(f) => <input {...f} className="input" type="email" value={p.email} maxLength={200} onChange={(e) => person(i, { email: e.target.value })} />}</Field>
                  <Field label="Profile">
                    {(f) => (
                      <select {...f} className="select" value={p.profile} onChange={(e) => person(i, { profile: e.target.value })}>
                        {team.profiles.map((x, j) => (
                          <option key={j} value={x.name}>
                            {x.name || '(no name yet)'}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field label="Starting password" error={p.password && pw ? pw : undefined}>
                    {(f) => (
                      <div className="row" style={{ gap: 6 }}>
                        <input {...f} className="input grow" type="text" autoComplete="off" value={p.password} maxLength={200} onChange={(e) => person(i, { password: e.target.value })} />
                        <button type="button" className="btn quiet small" onClick={() => person(i, { password: startingPassword() })}>
                          New
                        </button>
                      </div>
                    )}
                  </Field>
                </div>
              );
            })}
            <p className="xs muted">
              Give each person their email and starting password: they sign in with them, change the password under their name (top right), and set up two-factor sign-in if this server asks for it. Their sign-ins are made when you accept the terms, at the end.
            </p>
            <button type="button" className="btn quiet small start" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy their sign-ins'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
