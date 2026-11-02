/** This build's version (from the root package.json), set by Vite. */
declare const __SHAP_VERSION__: string;
/** True in the installable web app build (POCKET_WEB=1), false in the phone builds. */
declare const __POCKET_WEB__: boolean;
declare module 'virtual:pwa-register' {
  export function registerSW(options?: { immediate?: boolean; onNeedRefresh?: () => void; onOfflineReady?: () => void; onRegisteredSW?: (url: string, r: ServiceWorkerRegistration | undefined) => void }): (reload?: boolean) => Promise<void>;
}
