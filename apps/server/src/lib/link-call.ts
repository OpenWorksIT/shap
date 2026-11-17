/**
 * Shap Accountant asking a linked client's own Shap for something (modules/links.ts there): the
 * only requests a practice's server makes to an address someone typed in (.github/hosts.json).
 *
 * So it only goes where a client's Shap could be: https, to a public address (a name that resolves
 * to a private, loopback or link-local address is refused at connect time, so a name can't be
 * pointed somewhere inside after it was checked), no redirects followed, ten seconds at most, and
 * a small answer. On a practice's own network (and in the tests), LINK_PRIVATE lets it reach
 * private addresses, over http too.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { LINK_API } from '@shap/shared';

const LIMIT_BYTES = 2 * 1024 * 1024;

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

/** An address a linked client's Shap couldn't be at (unless the server allows private ones). */
export function privateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (!family) return true;
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is the IPv4 address. (A BlockList checks IPv4
  // against IPv6 rules as such already, so ::ffff:0:0/96 can't be a rule: it would take in every one.)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return privateAddress(mapped);
  if (family === 6 && /^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(ip)) return true;
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

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
  if (!allowPrivate && isIP(u.hostname.replace(/^\[|\]$/g, '')) && privateAddress(u.hostname.replace(/^\[|\]$/g, ''))) return 'That link points at a private address, which Shap Accountant doesn’t reach.';
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
      const ok = c.allowPrivate ? addresses : addresses.filter((a) => !privateAddress(a.address));
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
        timeout: 10_000,
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
          let json: Record<string, unknown> = {};
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            return reject(new LinkError(`Their Shap answered with something Shap Accountant doesn’t read (${res.statusCode}).`, 502, 'link_answer'));
          }
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) return reject(new LinkError('Their Shap sent Shap Accountant somewhere else: ask them for the link again, from the address they use for their Shap.', 502, 'link_redirect'));
          if (status === 404) return reject(new LinkError('Their Shap doesn’t link to an accountant yet: it needs Shap 1.30 or later. Ask whoever runs it to update it.', 502, 'link_old'));
          if (status >= 400) return reject(new LinkError(typeof json.error === 'string' ? json.error : `Their Shap refused (${status}).`, status, typeof json.code === 'string' ? json.code : undefined));
          resolve(json as T);
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new LinkError('Their Shap didn’t answer within ten seconds. Try again later, or ask whoever runs it whether it’s up.', 504, 'link_timeout')));
    req.on('error', (err: Error & { code?: string }) => {
      if (err instanceof LinkError) return reject(err);
      if (err.code === 'PRIVATE_ADDRESS') return reject(new LinkError('That link points at a private address, which Shap Accountant doesn’t reach.', 400, 'link_address'));
      reject(new LinkError(`Couldn’t reach their Shap at ${url.host} (${err.code ?? 'no answer'}). Check the link, or try again later.`, 502, 'link_unreachable'));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
