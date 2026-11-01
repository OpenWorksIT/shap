/**
 * Shap Pocket is one person's app on their own phone: no accounts, no passwords. The phone's
 * lock screen guards it (and the app can ask for it again on opening). Everything is done as
 * the owner, a single row in `users` that the books' "created by" columns point to.
 */
import type { Role } from '@shap/shared';
import type { Db } from './db/index.js';
import type { Req } from './http.js';
import { unauthorized } from './lib/errors.js';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/** The phone's owner, made the first time the app opens. */
export async function deviceOwner(db: Db): Promise<AuthUser> {
  const [u] = await db<AuthUser[]>`select id, name, email, role from users where role = 'owner' order by created_at limit 1`;
  if (u) return u;
  const [made] = await db<AuthUser[]>`
    insert into users (name, email, password_hash, role) values ('Owner', 'owner@this-phone', '', 'owner') returning id, name, email, role`;
  return made!;
}

/** Routes keep saying who may use them, for Shap's sake; on the phone it's always the owner. */
export function requireRole(..._roles: Role[]) {
  return async (req: Req) => {
    if (!req.user) throw unauthorized('The app is still starting');
  };
}

export function userOrThrow(req: Req): AuthUser {
  if (!req.user) throw unauthorized('The app is still starting');
  return req.user;
}

export const canWrite = (_u: AuthUser) => true;
export const seesMoney = (_u: AuthUser) => true;
