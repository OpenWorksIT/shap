/**
 * Settings → People who sign in: who signs in, and what each may do (docs/PEOPLE.md). The owner
 * does everything and the accountant reads everything; everyone else is staff, on a profile
 * (Teller, Admin, Site staff…) with anything changed for them on top. A profile is the jobs ticked
 * under the headings of the parts of Shap that are switched on; change it and everyone on it has
 * the change at once, except what was changed for them.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { formatDate, neededBy, passwordProblem, ROLE_HINTS, ROLE_LABELS, shownGroups, TASKS, withNeeds, type Role, type Task } from '@shap/shared';
import { Drawer, ErrorBox, Field, Icon, Loading, useToast } from './ui';
import { usePasswordPrompt } from './PasswordPrompt';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  lastLoginAt: string | null;
  mfa: boolean;
  profileId: string | null;
  profileName: string | null;
  accessAdd: Task[];
  accessRemove: Task[];
  access: Task[];
}
interface Profile {
  id: string;
  name: string;
  access: Task[];
  people: number;
}

const label = (k: string) => TASKS.find((t) => t.key === k)?.label ?? k;

/** What someone may do, in a few words, for the list. */
function accessSummary(u: UserRow): string {
  if (u.role !== 'staff') return ROLE_LABELS[u.role];
  const changed = u.accessAdd.length + u.accessRemove.length;
  if (u.profileName) return changed ? `${u.profileName}, changed for them` : u.profileName;
  return u.access.length ? `${u.access.length} job${u.access.length === 1 ? '' : 's'} ticked` : 'Nothing yet';
}

export function People() {
  const { user } = useAuthed();
  const users = useApi<UserRow[]>('/api/users');
  const profiles = useApi<Profile[]>('/api/profiles');
  const [edit, setEdit] = useState<UserRow | 'new' | null>(null);
  const [profile, setProfile] = useState<Profile | 'new' | null>(null);
  const reload = () => (void users.reload(), void profiles.reload());
  return (
    <div className="stack-lg">
      <section className="stack">
        <div className="spread">
          <p className="small muted">Everyone signs in as themselves. Give each person a profile (what a teller, an admin or site staff does), and change it for them if they do a bit more or less.</p>
          <button className="btn primary" onClick={() => setEdit('new')}>
            <Icon name="plus" size={18} />
            Add someone
          </button>
        </div>
        <ErrorBox error={users.error} />
        {!users.data ? (
          <Loading />
        ) : (
          <div className="panel table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>What they do</th>
                  <th className="hide-sm">Two-factor</th>
                  <th className="hide-sm">Last signed in</th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id} className={`clickable ${u.active ? '' : 'inactive'}`} onClick={() => setEdit(u)}>
                    <td>
                      <strong>{u.name}</strong>
                      {u.id === user.id && <span className="muted"> (you)</span>}
                      <div className="xs muted">{u.email}</div>
                    </td>
                    <td>{accessSummary(u)}</td>
                    <td className="hide-sm">{u.mfa ? 'On' : 'Off'}</td>
                    <td className="hide-sm">{u.lastLoginAt ? formatDate(u.lastLoginAt.slice(0, 10)) : 'Never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="stack">
        <div className="spread">
          <div>
            <h2 className="strong" style={{ fontSize: 'var(--fs-md)', margin: 0 }}>Profiles</h2>
            <p className="small muted">The jobs a kind of staff does. Change a profile and everyone on it has the change at once, except what you changed for them.</p>
          </div>
          <button className="btn" onClick={() => setProfile('new')}>
            <Icon name="plus" size={18} />
            New profile
          </button>
        </div>
        <ErrorBox error={profiles.error} />
        {profiles.data && (
          <ul className="panel list">
            {profiles.data.map((p) => (
              <li key={p.id}>
                <button type="button" className="list-row" onClick={() => setProfile(p)}>
                  <span className="grow">
                    <strong>{p.name}</strong>
                    <div className="xs muted">{p.access.length ? p.access.map(label).join(' · ') : 'Nothing ticked yet'}</div>
                  </span>
                  <span className="small muted nowrap">
                    {p.people} {p.people === 1 ? 'person' : 'people'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {edit && profiles.data && <UserDrawer user={edit === 'new' ? null : edit} profiles={profiles.data} onClose={() => setEdit(null)} onSaved={reload} />}
      {profile && <ProfileDrawer profile={profile === 'new' ? null : profile} onClose={() => setProfile(null)} onSaved={reload} />}
    </div>
  );
}

/* ------------------------------------------------------------------ the ticks */

/**
 * The jobs under their headings, for the parts of Shap that are switched on. Ticking a heading
 * ticks everything under it; a job another one needs is ticked with it (and can't be unticked
 * while that one is). What's ticked for a part that's switched off is kept as it was.
 */
export function AccessTicks({ value, onChange, base }: { value: Task[]; onChange: (v: Task[]) => void; base?: Task[] }) {
  const { has } = useAuthed();
  const groups = useMemo(() => shownGroups(has), [has]);
  const on = new Set(value);
  const needed = new Map<string, string[]>();
  for (const t of value) for (const n of withNeeds([t])) if (n !== t) needed.set(n, [...(needed.get(n) ?? []), label(t)]);
  const shown = new Set(groups.flatMap((g) => g.tasks.map((t) => t.key)));
  const hidden = value.filter((t) => !shown.has(t));
  const set = (keys: string[], tick: boolean) => {
    const next = new Set<string>(value);
    for (const k of keys) {
      if (tick) next.add(k);
      else {
        next.delete(k);
        // What needs it goes with it.
        for (const d of neededBy(k)) next.delete(d);
      }
    }
    onChange(withNeeds(next));
  };
  const changed = (k: string) => base !== undefined && base.includes(k as Task) !== on.has(k as Task);
  return (
    <div className="access">
      {groups.map((g) => {
        const keys = g.tasks.map((t) => t.key);
        const n = keys.filter((k) => on.has(k as Task)).length;
        return (
          <fieldset key={g.key} className="access-group">
            <legend>
              <label className="check access-head">
                <input
                  type="checkbox"
                  checked={n === keys.length}
                  ref={(el) => {
                    if (el) el.indeterminate = n > 0 && n < keys.length;
                  }}
                  onChange={(e) => set(keys, e.target.checked)}
                />
                <span className="strong">{g.label}</span>
              </label>
            </legend>
            {g.tasks.map((t) => {
              const why = needed.get(t.key);
              return (
                <label key={t.key} className="check access-task">
                  <input type="checkbox" checked={on.has(t.key as Task)} disabled={Boolean(why)} onChange={(e) => set([t.key], e.target.checked)} />
                  <span>
                    {t.label}
                    {changed(t.key) && <span className="access-changed">{on.has(t.key as Task) ? 'added for them' : 'taken off for them'}</span>}
                    {(why || t.hint) && <div className="xs muted">{why ? `Needed for ${why.join(', ')}` : t.hint}</div>}
                  </span>
                </label>
              );
            })}
          </fieldset>
        );
      })}
      {hidden.length > 0 && <p className="xs muted">Also kept: {hidden.map(label).join(', ')} (for parts of Shap that are switched off now).</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ a profile */

function ProfileDrawer({ profile, onClose, onSaved }: { profile: Profile | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(profile?.name ?? '');
  const [access, setAccess] = useState<Task[]>(profile?.access ?? []);
  const [error, setError] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (profile) await api(`/api/profiles/${profile.id}`, { method: 'PUT', body: { name, access } });
      else await api('/api/profiles', { body: { name, access } });
      toast(profile?.people ? `Saved: the ${profile.people === 1 ? 'person' : `${profile.people} people`} on it have it now` : 'Saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  const remove = async () => {
    if (!profile || !confirm(`Remove the profile “${profile.name}”?`)) return;
    try {
      await api(`/api/profiles/${profile.id}`, { method: 'DELETE' });
      toast('Removed');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t remove it');
    }
  };
  return (
    <Drawer title={profile ? profile.name : 'New profile'} sub={profile?.people ? `${profile.people} ${profile.people === 1 ? 'person is' : 'people are'} on it` : undefined} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Name" hint="What the job is called: Teller, Admin, Bookkeeper, Storeman…">
          {(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />}
        </Field>
        <div className="field">
          <span className="label">What they may do</span>
          <AccessTicks value={access} onChange={setAccess} />
        </div>
        <p className="xs muted">Always the owner’s: the settings, the people who sign in, the year end, tax estimates, dividends, approving the financial statements, and backups.</p>
        {error && <div className="banner alert small">{error}</div>}
        <div className="row wrap">
          <button className="btn primary">Save</button>
          {profile && profile.people === 0 && (
            <button type="button" className="btn quiet danger" onClick={() => void remove()}>
              Remove the profile
            </button>
          )}
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ a person */

/** Who they are to Shap: the owner, the accountant, staff on a profile, or staff with their own ticks. */
type Pick = { kind: 'owner' } | { kind: 'accountant' } | { kind: 'profile'; id: string } | { kind: 'own' };

function UserDrawer({ user, profiles, onClose, onSaved }: { user: UserRow | null; profiles: Profile[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { user: me } = useAuthed();
  const startPick: Pick = !user
    ? profiles[0]
      ? { kind: 'profile', id: profiles[0].id }
      : { kind: 'own' }
    : user.role === 'owner'
      ? { kind: 'owner' }
      : user.role === 'accountant'
        ? { kind: 'accountant' }
        : user.profileId
          ? { kind: 'profile', id: user.profileId }
          : { kind: 'own' };
  const [pick, setPick] = useState<Pick>(startPick);
  const profileOf = (p: Pick) => (p.kind === 'profile' ? profiles.find((x) => x.id === p.id) ?? null : null);
  const [access, setAccess] = useState<Task[]>(user?.role === 'staff' ? user.access : withNeeds(profileOf(startPick)?.access ?? []));
  const [adjust, setAdjust] = useState(Boolean(user && user.role === 'staff' && user.accessAdd.length + user.accessRemove.length));
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', password: '', active: user?.active ?? true, currentPassword: '' });
  const [error, setError] = useState('');
  const [passwordPrompt, askPassword] = usePasswordPrompt();
  const role: Role = pick.kind === 'owner' ? 'owner' : pick.kind === 'accountant' ? 'accountant' : 'staff';
  const profile = profileOf(pick);
  const base = withNeeds(profile?.access ?? []);
  const isMe = user?.id === me.id;
  // The acting owner re-enters their password for the high-impact moves (matching the server): your
  // own email/password, resetting someone else's password, making someone an owner, or editing an
  // existing owner — so a session left open on a phone can't take over or lock someone out.
  const resettingOther = Boolean(user) && !isMe && Boolean(f.password);
  const makingOwner = role === 'owner' && (!user || user.role !== 'owner');
  const editingOwner = Boolean(user) && !isMe && user?.role === 'owner';
  const needsCurrent = (isMe && (Boolean(f.password) || f.email.trim().toLowerCase() !== user?.email)) || resettingOther || makingOwner || editingOwner;
  const problem = f.password ? passwordProblem(f.password, f) : null;
  const choose = (p: Pick) => {
    setPick(p);
    // A new profile starts them on its ticks; adjust from there.
    if (p.kind === 'profile') setAccess(withNeeds(profileOf(p)?.access ?? []));
    if (p.kind === 'own' && pick.kind !== 'own') setAccess(access);
    setAdjust(false);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const staff = role === 'staff';
      const body = {
        name: f.name,
        email: f.email,
        role,
        active: f.active,
        profileId: staff && profile ? profile.id : null,
        access: staff ? (profile && !adjust ? base : access) : undefined,
        password: f.password || undefined,
        currentPassword: needsCurrent ? f.currentPassword : undefined,
      };
      if (user) await api(`/api/users/${user.id}`, { method: 'PUT', body });
      else await api('/api/users', { body });
      toast('Saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  const changes = role === 'staff' && profile ? access.filter((t) => !base.includes(t)).length + base.filter((t) => !access.includes(t)).length : 0;
  return (
    <Drawer title={user ? user.name : 'Add someone'} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Name">{(p) => <input {...p} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />}</Field>
          <Field label="Email (they sign in with this)">{(p) => <input {...p} className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />}</Field>
        </div>
        <div className="field">
          <span className="label">What they do</span>
          <div className="access-picks">
            <PickCard checked={pick.kind === 'owner'} onPick={() => choose({ kind: 'owner' })} title={ROLE_LABELS.owner} hint={ROLE_HINTS.owner} />
            <PickCard checked={pick.kind === 'accountant'} onPick={() => choose({ kind: 'accountant' })} title={ROLE_LABELS.accountant} hint={ROLE_HINTS.accountant} />
            {profiles.map((p) => (
              <PickCard key={p.id} checked={pick.kind === 'profile' && pick.id === p.id} onPick={() => choose({ kind: 'profile', id: p.id })} title={p.name} hint={p.access.length ? p.access.map(label).join(' · ') : 'Nothing ticked yet'} />
            ))}
            <PickCard checked={pick.kind === 'own'} onPick={() => choose({ kind: 'own' })} title="Only what I tick" hint="No profile: just the jobs you tick for them" />
          </div>
        </div>
        {role === 'staff' && profile && !adjust && (
          <button type="button" className="btn quiet small start" onClick={() => (setAccess(user?.role === 'staff' && user.profileId === profile.id ? user.access : base), setAdjust(true))}>
            Adjust for this person ▸
          </button>
        )}
        {role === 'staff' && (pick.kind === 'own' || adjust) && (
          <div className="field">
            <span className="label">
              {pick.kind === 'own' ? 'What they may do' : `What they may do: ${profile?.name}${changes ? `, with ${changes} change${changes === 1 ? '' : 's'} for them` : ''}`}
            </span>
            <AccessTicks value={access} onChange={setAccess} base={pick.kind === 'profile' ? base : undefined} />
            {pick.kind === 'profile' && changes > 0 && (
              <button type="button" className="btn quiet small start" onClick={() => setAccess(base)}>
                Back to the profile as it is
              </button>
            )}
          </div>
        )}
        <Field label={user ? 'New password (leave blank to keep)' : 'Starting password'} hint={problem ?? (isMe ? 'At least 10 characters.' : 'At least 10 characters. They can change it under their name, top right.')} error={problem ?? undefined}>
          {(p) => <input {...p} className="input" type="text" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required={!user} minLength={user ? undefined : 10} />}
        </Field>
        {needsCurrent && (
          <Field label="Your current password" hint="Enter your password to confirm this change.">
            {(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} required />}
          </Field>
        )}
        {user && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            Can sign in
          </label>
        )}
        {error && <div className="banner alert small">{error}</div>}
        <div className="row wrap">
          <button className="btn primary">Save</button>
          {user?.mfa && (
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const password = await askPassword('Reset two-factor', isMe ? 'Enter your password to reset your own two-factor sign-in.' : 'Enter your password to reset this person’s two-factor sign-in.');
                if (!password) return;
                try {
                  await api(`/api/users/${user.id}/reset-mfa`, { body: { password } });
                  toast('Two-factor reset; they set it up again at next sign-in');
                  onSaved();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : 'Couldn’t reset it');
                }
              }}
            >
              Reset two-factor (lost phone)
            </button>
          )}
        </div>
      </form>
      {passwordPrompt}
    </Drawer>
  );
}

function PickCard({ checked, onPick, title, hint }: { checked: boolean; onPick: () => void; title: string; hint: string }) {
  return (
    <label className={`access-pick${checked ? ' on' : ''}`}>
      <input type="radio" name="what-they-do" checked={checked} onChange={onPick} />
      <span>
        <span className="strong small">{title}</span>
        <span className="xs muted access-pick-hint">{hint}</span>
      </span>
    </label>
  );
}
