/**
 * What the server writes to its log (docker logs on a VPS): enough to see what happened and to
 * spot an attack, nothing personal. Requests are logged by method and path only: a query string
 * can hold what someone searched for (a client's name) or a token. Cookies and authorization
 * headers are blanked. The visitor's IP address stays, for security (rate limits, break-ins).
 * The privacy test (test/privacy.test.ts) runs the server with this log and looks for anything
 * personal in it.
 */
import type { Writable } from 'node:stream';

const pathOnly = (url: string | undefined) => String(url ?? '').replace(/\?.*$/, '');

export function serverLogger(opts: { dev: boolean; stream?: Writable }) {
  if (opts.dev) return { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } };
  return {
    level: 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    serializers: {
      req: (req: { method?: string; url?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) => ({
        method: req.method,
        url: pathOnly(req.url),
        hostname: req.hostname,
        remoteAddress: req.ip,
      }),
    },
    ...(opts.stream ? { stream: opts.stream } : {}),
  };
}

/**
 * An error as the log keeps it: what went wrong and where in the code, not the values involved.
 * (A database error's detail can quote them: "Key (email)=(someone@…) already exists".)
 */
export function safeError(err: unknown) {
  const e = (err ?? {}) as { name?: string; message?: string; code?: string; stack?: string; table_name?: string; constraint_name?: string; routine?: string };
  return { type: e.name, message: e.message, code: e.code, table: e.table_name, constraint: e.constraint_name, routine: e.routine, stack: e.stack };
}

/** Email addresses out of a message from elsewhere (a mail server's refusal can quote the recipient). */
export const withoutAddresses = (s: string) => String(s ?? '').replace(/[^\s<>"'()@]+@[^\s<>"'()]+/g, '…@…');
