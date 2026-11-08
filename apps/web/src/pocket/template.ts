/**
 * The empty books' address, as the page gives it to the database worker: only ever the file next
 * to the app (the same scheme and host, fresh-books.tar.gz), never anywhere else. Scheme and host
 * rather than origin: on iOS the app is served from capacitor://localhost, whose origin a URL
 * reads as "null". Tested in packages/engine/test/template.test.ts.
 */
export function ownTemplate(url: string, here: string): string | null {
  try {
    const at = new URL(here);
    const u = new URL(url, at);
    return u.protocol === at.protocol && u.host === at.host && u.pathname.endsWith('/fresh-books.tar.gz') ? u.href : null;
  } catch {
    return null;
  }
}
