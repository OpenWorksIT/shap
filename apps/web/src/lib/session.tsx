/**
 * Shap Pocket has no accounts: the books on this phone are the owner's. This keeps the
 * reference data (settings, accounts, lists) that every screen reads, and says how to talk
 * about the business.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { featureOn, type Feature, entity, payoutWord } from '@shap/shared';
import { api } from './api';
import { remember, remembered } from './snapshot';
import { setTone } from './words';
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

/** The reference data as the screens use it, and the app's way of speaking set to match. */
function prepared(r: Reference): Reference {
  setTone((r.settings as Settings).tone);
  // Credit notes settle invoices through a source of their own, never picked by hand; the
  // unpaid-bills source only shows with Supplier bills switched on.
  const bills = featureOn(r.settings.features, 'bills');
  return { ...r, sources: r.sources.filter((x) => x.role !== 'credit_notes' && (x.role !== 'bills' || bills)) };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  // Last time's, while the books open (lib/snapshot.ts): Home appears straight away.
  const [ref, setRef] = useState<Reference | null>(() => {
    const last = remembered<Reference>('/api/reference');
    return last ? prepared(last) : null;
  });
  const [error, setError] = useState<string | null>(null);

  const refreshReference = useCallback(async () => {
    const r = await api<Reference>('/api/reference');
    remember('/api/reference', r);
    setRef(prepared(r));
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
