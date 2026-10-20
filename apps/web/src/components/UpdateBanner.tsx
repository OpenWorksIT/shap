import { useEffect, useState } from 'react';
import { setStaleHandler } from '../lib/api';

/** Loads the new version of the app: drops the cached copy so the reload can't show the old one. */
export async function reloadNewVersion() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    if ('caches' in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch {
    /* reload anyway */
  }
  window.location.reload();
}

/**
 * Shown when Shap was updated while this page was open. Until it's reloaded the server refuses
 * changes from it (the screens may not match the new version), so this says so plainly.
 */
export function UpdateBanner() {
  const [server, setServer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setStaleHandler((v) => setServer(v)), []);
  if (!server) return null;
  return (
    <div className="update-banner" role="alert">
      <span className="grow">
        Shap has been updated to {server}. <strong>Reload</strong> to use the new version: changes can’t be saved from this page until you do.
      </span>
      <button
        className="btn small primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void reloadNewVersion();
        }}
      >
        {busy ? 'Reloading…' : 'Reload'}
      </button>
    </div>
  );
}
