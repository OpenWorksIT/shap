/**
 * The installable web app (Windows and other computers): opens offline, asks the browser to keep
 * its storage (so the books aren't cleared to free space), and takes updates quietly: a new
 * version waits until the app is in the background, or the next time it's opened.
 */
import { registerSW } from 'virtual:pwa-register';
import { isNative } from './native';

export function startWebApp() {
  if (isNative() || !__POCKET_WEB__) return;
  // Ask once: Edge and Chrome grant it for installed apps, so the books aren't evicted.
  void navigator.storage?.persist?.().catch(() => false);
  if (!('serviceWorker' in navigator)) return;
  let waiting = false;
  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      waiting = true;
    },
  });
  const apply = () => {
    if (waiting && document.visibilityState === 'hidden') void update(true);
  };
  document.addEventListener('visibilitychange', apply);
  // Check for a new version now and then while it's open (an hour).
  setInterval(() => void navigator.serviceWorker.getRegistration().then((r) => r?.update()), 3_600_000);
}

/** Whether the browser promised to keep this app's storage. */
export async function storageKept(): Promise<boolean | null> {
  try {
    return (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    return null;
  }
}
