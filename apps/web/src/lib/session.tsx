import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { featureOn, type Feature, entity, payoutWord, type Task } from '@shap/shared';
import { api, setNativeToken, setUnauthorizedHandler } from './api';
import { setTone } from './words';
import type { Reference, Settings, User } from './types';
import { startLive, stopLive } from './live';

/** What the password step asks for next. */
export type LoginStep =
  | { kind: 'done' }
  | { kind: 'verify'; challenge: string }
  | { kind: 'enrol'; challenge: string; secret: string; otpauthUrl: string };

interface SignedIn {
  user: User;
  token: string;
}

interface SessionValue {
  user: User | null;
  ref: Reference | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<LoginStep>;
  verifyMfa: (challenge: string, code: string) => Promise<void>;
  enrolMfa: (challenge: string, code: string) => Promise<{ recoveryCodes: string[]; enter: () => Promise<void> }>;
  logout: () => Promise<void>;
  refreshReference: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ref, setRef] = useState<Reference | null>(null);
  const [ready, setReady] = useState(false);

  const refreshReference = useCallback(async () => {
    const r = await api<Reference>('/api/reference');
    setTone((r.settings as Settings).tone);
    // Sources Shap posts to itself: credit notes are never picked; unpaid bills only with Supplier bills on.
    const bills = featureOn((r.settings as Settings).features, 'bills');
    setRef({ ...r, sources: r.sources.filter((x) => x.role !== 'credit_notes' && (x.role !== 'bills' || bills)) });
  }, []);

  const enter = useCallback(
    async (u: User) => {
      await refreshReference();
      setUser(u);
    },
    [refreshReference],
  );

  // Hear about other people's saves while signed in.
  useEffect(() => {
    if (user) startLive();
    else stopLive();
  }, [user]);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api<{ user: User }>('/api/auth/me')
      .then((r) => enter(r.user))
      .catch(() => {})
      .finally(() => setReady(true));
  }, [enter]);

  const signIn = useCallback(
    async (r: SignedIn) => {
      setNativeToken(r.token);
      await enter(r.user);
    },
    [enter],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<LoginStep> => {
      const r = await api<SignedIn | { mfa: 'verify'; challenge: string } | { mfa: 'enrol'; challenge: string; secret: string; otpauthUrl: string }>(
        '/api/auth/login',
        { body: { email, password } },
      );
      if ('mfa' in r) return r.mfa === 'verify' ? { kind: 'verify', challenge: r.challenge } : { kind: 'enrol', challenge: r.challenge, secret: r.secret, otpauthUrl: r.otpauthUrl };
      await signIn(r);
      return { kind: 'done' };
    },
    [signIn],
  );

  const verifyMfa = useCallback(
    async (challenge: string, code: string) => {
      await signIn(await api<SignedIn>('/api/auth/mfa/verify', { body: { challenge, code } }));
    },
    [signIn],
  );

  const enrolMfa = useCallback(
    async (challenge: string, code: string) => {
      const r = await api<SignedIn & { recoveryCodes: string[] }>('/api/auth/mfa/enrol', { body: { challenge, code } });
      return { recoveryCodes: r.recoveryCodes, enter: () => signIn(r) };
    },
    [signIn],
  );

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    setNativeToken(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, ref, ready, login, verifyMfa, enrolMfa, logout, refreshReference }),
    [user, ref, ready, login, verifyMfa, enrolMfa, logout, refreshReference],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Signed-in variant: only use inside the authenticated shell. */
export function useAuthed() {
  const s = useSession();
  const settings = s.ref!.settings as Settings;
  const u = s.user!;
  const can = (t: Task) => u.role === 'owner' || (u.access ?? []).includes(t);
  return {
    ...s,
    user: u,
    ref: s.ref!,
    settings,
    /** The settings, the people who sign in, the year end and the statements' approval are the owner's alone. */
    isOwner: u.role === 'owner',
    /** May they do this task? (packages/shared/src/access.ts; the server checks the same.) */
    can,
    canAny: (...ts: Task[]) => ts.some(can),
    /** Sees the books: the owner, the accountant, and staff who read the reports. */
    seesBooks: u.role !== 'staff' || can('reports.view'),
    /** Is this part of the app switched on? */
    has: (f: Feature) => featureOn(settings.features, f),
    /** How to say the owners' accounts, the business and its payouts, for this kind of business (entities.ts). */
    words: entityWords(settings.businessType),
  };
}

/** The words the screens use for a kind of business: "loan account", "the CC", "distribution". */
export function entityWords(businessType: string) {
  const k = entity(businessType);
  const payout = payoutWord(businessType);
  return {
    ownerAccount: k.key === 'sole_prop' ? 'owner’s account' : k.key === 'partnership' ? 'current account' : 'loan account',
    business: k.the,
    /** "dividend" or "distribution", and who it goes to ("shareholder", "member", "beneficiary"). */
    payout,
    Payouts: payout === 'dividend' ? 'Dividends' : 'Distributions',
    to: k.owner.one,
    dividendsTax: k.dividendsTax,
    /** What a director (or a CC's member, a trustee) on payroll is called. */
    director: k.key === 'cc' ? 'A member of the CC' : k.key === 'trust' ? 'A trustee' : 'A director of the company',
    directorAccount: k.accounts.director_salary,
  };
}
