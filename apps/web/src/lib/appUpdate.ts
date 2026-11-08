/**
 * Newer versions of the phone app. When it opens (and when it comes back to the front, at most
 * twice a day) it asks the store whether there's a newer version, and Home shows a reminder until
 * it's installed: updates carry tax-table, VAT and security fixes.
 *
 * On Android it's Google Play's own in-app update: Play's sheet offers the update (at most every
 * three days, so it doesn't nag), the new version downloads while you carry on, and "Restart"
 * installs it. On iPhone, Update opens the App Store. The web app on a computer updates itself
 * (pwa.ts). Installed some other way (not from a store) or offline: nothing is said.
 *
 * Google Play in-app updates: https://developer.android.com/guide/playcore/in-app-updates
 */
import { useEffect, useState } from 'react';
import { AppUpdate, AppUpdateAvailability, AppUpdateResultCode, FlexibleUpdateInstallStatus } from '@capawesome/capacitor-app-update';
import { isNative, platform } from './native';

export type UpdateState = { state: 'none' } | { state: 'available' } | { state: 'downloading'; pct: number | null } | { state: 'ready' };

let current: UpdateState = { state: 'none' };
const listeners = new Set<(s: UpdateState) => void>();
const emit = (s: UpdateState) => {
  current = s;
  listeners.forEach((l) => l(s));
};

/** For Home: where the update stands. */
export function useAppUpdate(): UpdateState {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    setS(current);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

export const storeName = () => (platform() === 'ios' ? 'the App Store' : 'Google Play');

const ASKED = 'shap.updateAskedAt';
const ASK_EVERY = 3 * 86_400_000;
const CHECK_EVERY = 12 * 3_600_000;
let lastCheck = 0;

const read = (k: string) => {
  try {
    return Number(localStorage.getItem(k) ?? 0);
  } catch {
    return 0;
  }
};
const write = (k: string, v: number) => {
  try {
    localStorage.setItem(k, String(v));
  } catch {
    /* not remembered: Play's sheet may come back sooner */
  }
};

/** Asks the store. `prompt`: also show Play's own update sheet, if it wasn't shown in the last three days. */
async function check(prompt: boolean): Promise<void> {
  lastCheck = Date.now();
  try {
    const info = await AppUpdate.getAppUpdateInfo();
    if (info.installStatus === FlexibleUpdateInstallStatus.DOWNLOADED) return emit({ state: 'ready' });
    if (info.updateAvailability === AppUpdateAvailability.UPDATE_IN_PROGRESS) return emit({ state: 'downloading', pct: null });
    if (info.updateAvailability !== AppUpdateAvailability.UPDATE_AVAILABLE) return emit({ state: 'none' });
    emit({ state: 'available' });
    if (prompt && platform() === 'android' && info.flexibleUpdateAllowed && Date.now() - read(ASKED) > ASK_EVERY) {
      write(ASKED, Date.now());
      await startUpdate();
    }
  } catch {
    /* not from a store, or offline: say nothing */
  }
}

/** The Update button (and Play's sheet when it's due): download in the background on Android, the App Store on iPhone. */
export async function startUpdate(): Promise<void> {
  try {
    if (platform() === 'ios') return await AppUpdate.openAppStore();
    const info = await AppUpdate.getAppUpdateInfo();
    if (info.flexibleUpdateAllowed) {
      const r = await AppUpdate.startFlexibleUpdate();
      if (r.code === AppUpdateResultCode.OK) emit({ state: 'downloading', pct: null });
    } else if (info.immediateUpdateAllowed) {
      await AppUpdate.performImmediateUpdate();
    } else {
      await AppUpdate.openAppStore();
    }
  } catch {
    // Play couldn't start it here: its store page has the Update button.
    await AppUpdate.openAppStore().catch(() => undefined);
  }
}

/** Restart into the downloaded version. */
export async function finishUpdate(): Promise<void> {
  await AppUpdate.completeFlexibleUpdate().catch(() => emit({ state: 'available' }));
}

/** From main.tsx: the phone app checks now, and when it comes back to the front (at most twice a day). */
export function startUpdateChecks(): void {
  if (!isNative()) return;
  if (platform() === 'android') {
    void AppUpdate.addListener('onFlexibleUpdateStateChange', (s) => {
      if (s.installStatus === FlexibleUpdateInstallStatus.DOWNLOADED) emit({ state: 'ready' });
      else if (s.installStatus === FlexibleUpdateInstallStatus.DOWNLOADING || s.installStatus === FlexibleUpdateInstallStatus.PENDING)
        emit({ state: 'downloading', pct: s.totalBytesToDownload ? Math.round((100 * (s.bytesDownloaded ?? 0)) / s.totalBytesToDownload) : null });
      else if (s.installStatus === FlexibleUpdateInstallStatus.FAILED || s.installStatus === FlexibleUpdateInstallStatus.CANCELED) emit({ state: 'available' });
    }).catch(() => undefined);
  }
  // A few seconds in, so opening the books comes first.
  setTimeout(() => void check(true), 4000);
  void import('@capacitor/app').then(({ App }) =>
    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive && Date.now() - lastCheck > CHECK_EVERY) void check(true);
    }),
  );
}
