/**
 * Two Shaps for the tests of linked clients (docs/ACCOUNTANT.md, "A client on its own Shap"): a
 * practice's, with Shap Accountant switched on, and a business's own, listening on a port of its own
 * (its database `<test db>_<name>`). All data made up.
 */
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { ACCOUNTANT_TERMS_VERSION } from '@shap/shared';
import { appVersion } from '../../src/modules/system.js';
import { login, setup, type TestEnv } from '../helpers.js';

export type Session = Awaited<ReturnType<typeof login>>;

export interface LinkPair {
  practice: TestEnv;
  own: TestEnv;
  /** Where the business's own Shap listens. */
  base: string;
  /** The practice's owner, and the business's owner. */
  owner: Session;
  theirs: Session;
  /** A link from the business's own Shap, as its owner makes it, pointed at where it listens here. */
  makeLink: (level: 'books' | 'compile') => Promise<string>;
  /** Links a client, as the practice's owner: its id. */
  link: (level: 'books' | 'compile') => Promise<string>;
  /** What a browser does with a sign-in: opens it on the client's Shap, with these cookies, and keeps what it's given. */
  enter: (url: string, cookies?: Record<string, string>) => Promise<{ status: number; location: string | undefined; cookie: string | undefined; cleared: string[] }>;
  /** Someone in the client's Shap with that session cookie. */
  asThem: (cookie: string) => { get: (url: string) => Promise<LightMyRequestResponse>; post: (url: string, payload: unknown, method?: 'POST' | 'PUT') => Promise<LightMyRequestResponse> };
  close: () => Promise<void>;
}

export async function linkPair(name: string, ownEnv: Record<string, string> = {}): Promise<LinkPair> {
  const ownDb = `${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_${name}`;
  const practice = await setup({ env: { LINK_PRIVATE: 'true' } });
  await practice.sql.unsafe(`drop database if exists "${ownDb}" with (force)`);
  await practice.sql.unsafe(`create database "${ownDb}"`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${ownDb}`;
  const own = await setup({ env: { DATABASE_URL: url.toString(), PUBLIC_URL: 'https://books.made-up-own.example', ...ownEnv } });
  await own.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(own.app.server.address() as AddressInfo).port}`;
  const theirs = await login(own.app, 'owner@example.co.za');
  const { settings } = await theirs.get('/api/reference');
  await theirs.post('/api/settings', { ...settings, companyName: 'Made-up Own Books (Pty) Ltd', businessType: 'company', fyEndMonth: 2 }, 'PUT');
  const owner = await login(practice.app, 'owner@example.co.za');
  const s = (await owner.get('/api/reference')).settings;
  await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
  await owner.post('/api/settings', { ...s, companyName: 'Made-up Practice Inc', features: { ...s.features, practice: true } }, 'PUT');

  const makeLink = async (level: 'books' | 'compile') => {
    const made = await theirs.post<{ link: string }>('/api/accountant-links', { level, password: 'test-password-1' });
    return made.link.replace(/^https?:\/\/[^/]+/, base);
  };
  return {
    practice,
    own,
    base,
    owner,
    theirs,
    makeLink,
    link: async (level) => (await owner.post<{ id: string }>('/api/practice/clients/link', { link: await makeLink(level) })).id,
    enter: async (to, cookies) => {
      const r = await own.app.inject({ method: 'GET', url: to.slice(base.length), cookies });
      return {
        status: r.statusCode,
        location: r.headers.location as string | undefined,
        cookie: r.cookies.find((c) => c.name === 'shap_session' && c.value)?.value,
        cleared: r.cookies.filter((c) => !c.value || (c.expires && c.expires.getTime() < Date.now())).map((c) => c.name),
      };
    },
    asThem: (cookie) => ({
      get: (to) => own.app.inject({ method: 'GET', url: to, cookies: { shap_session: cookie } }),
      post: (to, payload, method = 'POST') => own.app.inject({ method, url: to, payload: payload as never, cookies: { shap_session: cookie }, headers: { 'x-shap-version': appVersion() } }),
    }),
    close: async () => {
      await own.close();
      await practice.ctx.clients.end();
      await practice.close();
      const pg = await setup();
      await pg.sql.unsafe(`drop database if exists "${ownDb}" with (force)`);
      await pg.close();
    },
  };
}
