/**
 * Shap Pocket has no accounts: the books on this phone are the owner's. This keeps the
 * reference data (settings, accounts, lists) that every screen reads, and says how to talk
 * about the business.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { featureOn, type Feature } from '@shap/shared';
import { api } from './api';
import type { Reference, Settings, User } from './types';

interface SessionValue {
  user: User | null;
  ref: Reference | null;
  ready: boolean;
  /** The books couldn't be opened (shown instead of the app). */
  error: string | null;
  refreshReference: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const OWNER: User = { id: 'owner', name: 'You', email: '', role: 'owner' };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ref, setRef] = useState<Reference | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshReference = useCallback(async () => {
    setRef(await api<Reference>('/api/reference'));
  }, []);

  useEffect(() => {
    refreshReference().catch((e: Error) => setError(e.message));
  }, [refreshReference]);

  const value = useMemo(() => ({ user: ref ? OWNER : null, ref, ready: Boolean(ref) || Boolean(error), error, refreshReference }), [ref, error, refreshReference]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Inside the app, once the books are open. */
export function useAuthed() {
  const s = useSession();
  const settings = s.ref!.settings as Settings;
  return {
    ...s,
    user: s.user!,
    ref: s.ref!,
    settings,
    isOwner: true,
    seesMoney: true,
    /** Is this part of the app switched on? */
    has: (f: Feature) => featureOn(settings.features, f),
    /** How to say the owner's account and the business, for a company or a sole proprietor. */
    words: settings.businessType === 'sole_prop' ? { ownerAccount: 'owner’s account', business: 'the business' } : { ownerAccount: 'loan account', business: 'the company' },
  };
}
