/**
 * Shap Accountant asking a linked client's own Shap for something (modules/links.ts there): the
 * only requests a practice's server makes to an address someone typed in (.github/hosts.json).
 *
 * So it only goes where a client's Shap could be: https, to a public address (a name that resolves
 * to a private, loopback or link-local address is refused at connect time, so a name can't be
 * pointed somewhere inside after it was checked), no redirects followed, ten seconds at most, and
 * a small answer. On a practice's own network (and in the tests), LINK_PRIVATE lets it reach
 * private addresses, over http too (never link-local ones such as a cloud server's metadata).
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { LINK_API } from '@shap/shared';

const LIMIT_BYTES = 2 * 1024 * 1024;
const TIME_MS = 10_000;

const blocked = new BlockList();
// Never reached, whatever the server allows: nowhere, link-local (a cloud server's metadata among
// them), multicast and what's reserved.
const never = new BlockList();
for (const [net, bits, list] of [
  ['0.0.0.0', 8, never],
  ['10.0.0.0', 8, blocked],
  ['100.64.0.0', 10, blocked],
  ['127.0.0.0', 8, blocked],
  ['169.254.0.0', 16, never],
  // A cloud server's metadata where it isn't link-local (Alibaba's).
  ['100.100.100.200', 32, never],
  ['172.16.0.0', 12, blocked],
  ['192.0.0.0', 24, blocked],
  ['192.168.0.0', 16, blocked],
  ['198.18.0.0', 15, blocked],
  ['224.0.0.0', 4, never],
  ['240.0.0.0', 4, never],
] as const)
  list.addSubnet(net, bits, 'ipv4');
for (const [net, bits, list] of [
  // An IPv4 address inside one of these could be anything (::a.b.c.d, ::ffff:0:a.b.c.d, NAT64, 6to4, Teredo).
  ['::', 96, blocked],
  ['::ffff:0:0:0', 96, blocked],
  ['64:ff9b::', 96, blocked],
  ['64:ff9b:1::', 48, blocked],
  ['100::', 64, never],
  ['2001::', 32, blocked],
  ['2001:db8::', 32, never],
  ['2002::', 16, blocked],
  ['fc00::', 7, blocked],
  ['fe80::', 10, never],
  // AWS's metadata over IPv6.
  ['fd00:ec2::254', 128, never],
  ['fec0::', 10, blocked],
  ['ff00::', 8, never],
] as const)
  list.addSubnet(net, bits, 'ipv6');

/** An IPv6 address's eight groups (16 bits each), whichever way it's written; null if it isn't one. */
function groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail, more] = text.split('::');
  if (more !== undefined) return null;
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const all = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return all.length === 8 ? all.map((g) => parseInt(g, 16)) : null;
}

/**
 * The IPv4 address an IPv6 one carries, where it carries one: mapped (::ffff:a.b.c.d), compatible
 * (::a.b.c.d), translated (::ffff:0:a.b.c.d), NAT64 (64:ff9b::/96, 64:ff9b:1::/48), 6to4 (2002::/16)
 * and Teredo (2001::/32, the client's address inverted), so it's judged as that IPv4 address is.
 */
function asIpv4(ip: string): string | null {
  const g = groups(ip);
  if (!g) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (zero(0, 6) && (g[6]! | g[7]!) !== 0 && !(g[6] === 0 && g[7] === 1)) return v4(g[6]!, g[7]!);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && (zero(2, 6) || g[2] === 1)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  if (g[0] === 0x2001 && g[1] === 0) return v4(g[6]! ^ 0xffff, g[7]! ^ 0xffff);
  return null;
}

/** An address no linked client's Shap is ever reached at, private ones allowed or not. */
export function neverReached(ip: string): boolean {
  const family = isIP(ip);
  if (!family) return true;
  const v4 = family === 6 ? asIpv4(ip) : null;
  if (v4 && neverReached(v4)) return true;
  return never.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/** An address a linked client's Shap couldn't be at (unless the server allows private ones). */
export function privateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (!family) return true;
  // The IPv4 address inside is judged as itself, and the IPv6 form by its own rules too. (A
  // BlockList checks IPv4 against IPv6 rules as such already, so ::ffff:0:0/96 can't be a rule: it
  // would take in every one.)
  const v4 = family === 6 ? asIpv4(ip) : null;
  if (v4 && privateAddress(v4)) return true;
  if (v4 && /^::ffff:/i.test(ip)) return false;
  const list = family === 6 ? 'ipv6' : 'ipv4';
  return never.check(ip, list) || blocked.check(ip, list);
}

/** Where the server may connect: never somewhere never reached; a private address only if it allows them. */
const mayReach = (ip: string, allowPrivate: boolean) => (allowPrivate ? !neverReached(ip) : !privateAddress(ip));

export class LinkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface LinkCall {
  /** The client's Shap's address (an origin, such as https://books.example). */
  base: string;
  method: 'GET' | 'POST';
  path: string;
  credential?: string;
  body?: unknown;
  allowPrivate: boolean;
  version: string;
  /** All the time it takes (TIME_MS; less in the tests). */
  timeMs?: number;
}

/** Where a link may point: https (or http, and any address, where the server allows private ones). */
export function linkBaseProblem(base: string, allowPrivate: boolean): string | null {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return 'That isn’t a link from Shap.';
  }
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) return 'Their Shap must be reached over https: ask them for the link again, from the address they use for their Shap.';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !mayReach(host, allowPrivate)) return 'That link points at a private address, which Shap Accountant doesn’t reach.';
  return null;
}

export async function linkCall<T>(c: LinkCall): Promise<T> {
  const problem = linkBaseProblem(c.base, c.allowPrivate);
  if (problem) throw new LinkError(problem, 400, 'link_address');
  const url = new URL(c.path, c.base);
  const body = c.body === undefined ? undefined : JSON.stringify(c.body);
  const lookup: RequestOptions['lookup'] = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return (callback as (e: Error | null, a: string | LookupAddress[], f?: number) => void)(err, []);
      const ok = addresses.filter((a) => mayReach(a.address, c.allowPrivate));
      if (!ok.length) return (callback as (e: Error | null, a: string | LookupAddress[], f?: number) => void)(Object.assign(new Error('a private address'), { code: 'PRIVATE_ADDRESS' }), []);
      if ((options as { all?: boolean }).all) return (callback as (e: Error | null, a: LookupAddress[]) => void)(null, ok);
      (callback as (e: Error | null, a: string, f: number) => void)(null, ok[0]!.address, ok[0]!.family);
    });
  };
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<T>((resolve, reject) => {
    const req = send(
      url,
      {
        method: c.method,
        lookup,
        timeout: c.timeMs ?? TIME_MS,
        headers: {
          accept: 'application/json',
          'user-agent': `Shap/${c.version} (Shap Accountant)`,
          'x-shap-link-api': String(LINK_API),
          ...(c.credential ? { authorization: `Bearer link.${c.credential}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > LIMIT_BYTES) req.destroy(new LinkError('Their Shap answered with more than Shap Accountant reads.', 502, 'link_answer'));
          else chunks.push(d);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> | null = {};
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            return reject(new LinkError(`Their Shap answered with something Shap Accountant doesn’t read (${res.statusCode}).`, 502, 'link_answer'));
          }
          const status = res.statusCode ?? 0;
          // A JSON object, or nothing that's read as one.
          if (status < 300 && (json === null || typeof json !== 'object' || Array.isArray(json))) return reject(new LinkError('Their Shap answered in a way this Shap doesn’t read: one of the two may need updating.', 502, 'link_answer'));
          if (status >= 300 && status < 400) return reject(new LinkError('Their Shap sent Shap Accountant somewhere else: ask them for the link again, from the address they use for their Shap.', 502, 'link_redirect'));
          if (status === 404) return reject(new LinkError('Their Shap doesn’t link to an accountant yet: it needs Shap 1.30 or later. Ask whoever runs it to update it.', 502, 'link_old'));
          // What their Shap says in words isn't passed on (whoever runs a server can make it say
          // anything, in Shap's name): only its code, which the practice puts in its own words.
          if (status >= 400) return reject(new LinkError(`Their Shap refused (${status}).`, status, typeof json?.code === 'string' && /^[a-z_]{1,40}$/.test(json.code) ? json.code : undefined));
          resolve(json as T);
        });
        res.on('error', reject);
      },
    );
    // Ten seconds for all of it, however slowly it comes (the socket's own timeout is only for silence).
    const late = () => req.destroy(new LinkError('Their Shap didn’t answer within ten seconds. Try again later, or ask whoever runs it whether it’s up.', 504, 'link_timeout'));
    const deadline = setTimeout(late, c.timeMs ?? TIME_MS);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', late);
    req.on('error', (err: Error & { code?: string }) => {
      if (err instanceof LinkError) return reject(err);
      if (err.code === 'PRIVATE_ADDRESS') return reject(new LinkError('That link points at a private address, which Shap Accountant doesn’t reach.', 400, 'link_address'));
      const why = err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? 'no such address' : err.code === 'ECONNREFUSED' ? 'nothing answered there' : /CERT|SSL|TLS/i.test(err.code ?? err.message) ? 'its https certificate wasn’t one Shap trusts' : 'no answer';
      reject(new LinkError(`Couldn’t reach their Shap at ${url.host} (${why}). Check the link, or try again later.`, 502, 'link_unreachable'));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
