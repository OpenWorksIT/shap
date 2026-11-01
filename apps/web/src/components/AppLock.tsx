/**
 * Optional: ask for the phone's own lock (Face ID, fingerprint, or the phone's PIN or pattern)
 * when Shap opens, and again after it's been in the background a while. Nothing new to
 * remember: it's the same lock as the phone's. Switched on in Settings → Backup & security.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { isNative } from '../lib/native';
import { Logo } from './Logo';

const KEY = 'shap.lock';
/** Back from the background after this long: ask again. */
const AWAY_MS = 60_000;

export async function lockEnabled(): Promise<boolean> {
  if (!isNative()) return false;
  const { Preferences } = await import('@capacitor/preferences');
  return (await Preferences.get({ key: KEY })).value === 'on';
}

/** Whether the phone itself has a lock set (no lock, nothing to ask for). */
export async function phoneHasLock(): Promise<boolean> {
  if (!isNative()) return false;
  const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
  const r = await BiometricAuth.checkBiometry();
  return r.isAvailable || r.deviceIsSecure;
}

/** Asks for the phone's lock. True if it was given. */
export async function unlock(reason = 'Open your books'): Promise<boolean> {
  if (!isNative()) return true;
  const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
  try {
    await BiometricAuth.authenticate({ reason, cancelTitle: 'Cancel', allowDeviceCredential: true, androidTitle: 'Shap Pocket', androidSubtitle: reason, iosFallbackTitle: 'Use passcode' });
    return true;
  } catch {
    return false;
  }
}

export async function setLock(on: boolean): Promise<boolean> {
  const { Preferences } = await import('@capacitor/preferences');
  // Turning it on proves it works first, so nobody locks themselves out.
  if (on && !(await unlock('Confirm it’s you'))) return false;
  await Preferences.set({ key: KEY, value: on ? 'on' : 'off' });
  return true;
}

export function AppLock({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'locked' | 'open'>('checking');
  const hiddenAt = useRef<number | null>(null);

  const ask = useCallback(async () => {
    setState('locked');
    if (await unlock()) setState('open');
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    void (async () => {
      if (!(await lockEnabled())) return setState('open');
      await ask();
      const { App } = await import('@capacitor/app');
      const h = await App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) hiddenAt.current = Date.now();
        else if (hiddenAt.current && Date.now() - hiddenAt.current > AWAY_MS) {
          hiddenAt.current = null;
          void lockEnabled().then((on) => {
            if (on) void ask();
          });
        }
      });
      off = () => void h.remove();
    })();
    return () => off?.();
  }, [ask]);

  if (state === 'open') return <>{children}</>;
  return (
    <div className="lock-screen">
      <Logo size={64} />
      <h1>Shap Pocket</h1>
      {state === 'locked' && (
        <button className="btn primary big" onClick={() => void ask()}>
          Unlock
        </button>
      )}
    </div>
  );
}
