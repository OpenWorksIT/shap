/** The phone builds' stand-in for the web app's service worker registration: nothing to do. */
export function registerSW(): (reload?: boolean) => Promise<void> {
  return async () => {};
}
