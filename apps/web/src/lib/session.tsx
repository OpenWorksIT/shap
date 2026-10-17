import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setNativeToken, setUnauthorizedHandler } from './api';
import type { Reference, Settings, User } from './types';

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
    setRef(await api<Reference>('/api/reference'));
  }, []);

  const enter = useCallback(
    async (u: User) => {
      await refreshReference();
      setUser(u);
    },
    [refreshReference],
  );

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
  return {
    ...s,
    user: s.user!,
    ref: s.ref!,
    settings,
    isOwner: s.user!.role === 'owner',
    seesMoney: s.user!.role !== 'capture',
  };
}
