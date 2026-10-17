import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loginInput, type Role } from '@shap/shared';
import { z } from 'zod';
import type { Ctx } from './context.js';
import type { Db } from './db/index.js';
import { audit } from './lib/audit.js';
import { badRequest, forbidden, HttpError, unauthorized } from './lib/errors.js';
import { newToken, sha256 } from './lib/tokens.js';
import { newRecoveryCodes, newTotpSecret, normaliseRecoveryCode, otpauthUrl, verifyTotp } from './lib/totp.js';
import { parse } from './lib/validate.js';

export const SESSION_COOKIE = 'shap_session';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

/**
 * Sessions and sign-in (the same scheme as Sorted).
 * - Sessions are opaque tokens (stored hashed) in an httpOnly cookie, or a Bearer header for native apps.
 * - Two-factor sign-in (TOTP) is checked after the password, using a short-lived signed challenge.
 */
export function registerAuth(app: FastifyInstance, ctx: Ctx): void {
  const { sql, config, secrets } = ctx;
  app.decorateRequest('user', null);

  const tokenFrom = (req: FastifyRequest) => {
    const header = req.headers.authorization;
    return header?.startsWith('Bearer ') ? header.slice(7) : req.cookies[SESSION_COOKIE];
  };

  app.addHook('onRequest', async (req) => {
    const token = tokenFrom(req);
    if (!token) return;

    const rows = await sql<(AuthUser & { lastSeenAt: Date })[]>`
      select u.id, u.name, u.email, u.role, s.last_seen_at
      from sessions s join users u on u.id = s.user_id
      where s.token_hash = ${sha256(token)} and s.expires_at > now() and u.active
    `;
    const row = rows[0];
    if (!row) return;
    const { lastSeenAt, ...user } = row;
    req.user = user;
    // Sliding expiry, but only touch the row once a minute.
    if (Date.now() - lastSeenAt.getTime() > 60_000) {
      await sql`
        update sessions set last_seen_at = now(),
          expires_at = now() + make_interval(hours => ${config.SESSION_TTL_HOURS})
        where token_hash = ${sha256(token)}
      `;
    }
  });

  /** Create a session and set the cookie. Returns the token too, for native clients. */
  const startSession = async (req: FastifyRequest, reply: FastifyReply, user: AuthUser, method: string) => {
    const token = newToken();
    await sql`
      insert into sessions (token_hash, user_id, expires_at, user_agent, ip)
      values (${sha256(token)}, ${user.id}, now() + make_interval(hours => ${config.SESSION_TTL_HOURS}),
              ${String(req.headers['user-agent'] ?? '').slice(0, 300)}, ${req.ip})
    `;
    await sql`update users set last_login_at = now() where id = ${user.id}`;
    await audit(sql, { userId: user.id, action: 'login', entity: 'user', entityId: user.id, ip: req.ip, details: { method } });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.COOKIE_SECURE,
      path: '/',
      maxAge: config.SESSION_TTL_HOURS * 3600,
    });
    return { user, token };
  };

  const enrolChallenge = (user: AuthUser) => {
    const secret = newTotpSecret();
    return {
      challenge: secrets.signToken('mfa-enrol', { uid: user.id, s: secrets.seal(secret) }, 15 * 60),
      secret,
      otpauthUrl: otpauthUrl(secret, user.email),
    };
  };

  // ---- Step 1: password ------------------------------------------------------
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const input = parse(loginInput, req.body);
    const rows = await sql<(AuthUser & { passwordHash: string; active: boolean; totpEnabledAt: Date | null })[]>`
      select id, name, email, role, password_hash, active, totp_enabled_at from users where email = ${input.email}
    `;
    const row = rows[0];
    // Always run a verify so response time does not reveal whether the email exists.
    const ok = await verify(row?.passwordHash ?? (await getDummyHash()), input.password).catch(() => false);
    if (!row || !ok || !row.active) {
      await audit(sql, { action: 'login_failed', entity: 'user', entityId: row?.id ?? null, actor: 'user', ip: req.ip, details: { email: input.email } });
      throw unauthorized('Email or password is incorrect');
    }
    const { passwordHash: _ph, active: _a, totpEnabledAt, ...user } = row;

    if (totpEnabledAt) {
      return { mfa: 'verify', challenge: secrets.signToken('mfa-verify', { uid: user.id }, 5 * 60) };
    }
    if (config.mfaRequired) {
      return { mfa: 'enrol', ...enrolChallenge(user) };
    }
    return startSession(req, reply, user, 'password');
  });

  // ---- Step 2: authenticator code (or a recovery code) ------------------------
  app.post('/api/auth/mfa/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { challenge, code } = parse(z.object({ challenge: z.string().min(10).max(2000), code: z.string().trim().min(6).max(20) }), req.body);
    const p = secrets.verifyToken<{ uid: string }>('mfa-verify', challenge);
    if (!p) throw unauthorized('That sign-in took too long. Please start again.');
    const [row] = await sql<(AuthUser & { totpSecretEnc: string | null; totpLastStep: string | null })[]>`
      select id, name, email, role, totp_secret_enc, totp_last_step from users where id = ${p.uid} and active
    `;
    if (!row?.totpSecretEnc) throw unauthorized('Please sign in again.');
    const { totpSecretEnc, totpLastStep, ...user } = row;

    const isRecovery = /[a-z]/i.test(code);
    if (isRecovery) {
      const [used] = await sql<{ id: string }[]>`
        update recovery_codes set used_at = now()
        where id = (select id from recovery_codes where user_id = ${user.id} and used_at is null
                    and code_hash = ${secrets.hash(normaliseRecoveryCode(code))} limit 1)
        returning id
      `;
      if (!used) {
        await audit(sql, { userId: user.id, action: 'mfa_failed', entity: 'user', entityId: user.id, ip: req.ip, details: { kind: 'recovery' } });
        throw unauthorized('That recovery code isn’t valid or has been used.');
      }
      return startSession(req, reply, user, 'recovery_code');
    }

    const step = verifyTotp(secrets.open(totpSecretEnc), code, { afterStep: totpLastStep == null ? null : Number(totpLastStep) });
    if (step == null) {
      await audit(sql, { userId: user.id, action: 'mfa_failed', entity: 'user', entityId: user.id, ip: req.ip, details: { kind: 'totp' } });
      throw unauthorized('That code isn’t right. Check the time on your phone and try the newest code.');
    }
    await sql`update users set totp_last_step = ${step} where id = ${user.id}`;
    return startSession(req, reply, user, 'totp');
  });

  // ---- Setting up an authenticator (at sign-in when required, or later from the account screen) ----
  app.post('/api/auth/mfa/setup', async (req) => {
    if (!req.user) throw unauthorized();
    return enrolChallenge(req.user);
  });

  app.post('/api/auth/mfa/enrol', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { challenge, code } = parse(z.object({ challenge: z.string().min(10).max(4000), code: z.string().trim().min(6).max(10) }), req.body);
    const p = secrets.verifyToken<{ uid: string; s: string }>('mfa-enrol', challenge);
    if (!p) throw unauthorized('Setup took too long. Please start again.');
    if (req.user && req.user.id !== p.uid) throw forbidden();
    const secret = secrets.open(p.s);
    const step = verifyTotp(secret, code);
    if (step == null) throw badRequest('That code isn’t right. Make sure you scanned the code just shown, then try the newest code.');

    const codes = newRecoveryCodes();
    const user = await sql.begin(async (tx) => {
      const [u] = await tx<AuthUser[]>`
        update users set totp_secret_enc = ${secrets.seal(secret)}, totp_enabled_at = now(), totp_last_step = ${step}
        where id = ${p.uid} and active returning id, name, email, role
      `;
      if (!u) throw unauthorized();
      await tx`delete from recovery_codes where user_id = ${u.id}`;
      for (const c of codes) await tx`insert into recovery_codes (user_id, code_hash) values (${u.id}, ${secrets.hash(normaliseRecoveryCode(c))})`;
      await audit(tx, { userId: u.id, action: 'mfa_enabled', entity: 'user', entityId: u.id, ip: req.ip });
      return u;
    });

    // Enrolling as part of sign-in completes the sign-in.
    if (!req.user) return { recoveryCodes: codes, ...(await startSession(req, reply, user, 'totp_enrol')) };
    return { recoveryCodes: codes };
  });

  app.get('/api/auth/mfa', async (req) => {
    if (!req.user) throw unauthorized();
    const [row] = await sql<{ enabled: boolean; left: number }[]>`
      select totp_enabled_at is not null as enabled,
        (select count(*)::int from recovery_codes r where r.user_id = u.id and r.used_at is null) as left
      from users u where id = ${req.user.id}
    `;
    return { enabled: row!.enabled, required: config.mfaRequired, recoveryCodesLeft: row!.left };
  });

  app.post('/api/auth/mfa/recovery-codes', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    if (!req.user) throw unauthorized();
    const { code } = parse(z.object({ code: z.string().trim().min(6).max(10) }), req.body);
    const [row] = await sql<{ totpSecretEnc: string | null }[]>`select totp_secret_enc from users where id = ${req.user.id}`;
    if (!row?.totpSecretEnc || verifyTotp(secrets.open(row.totpSecretEnc), code) == null) throw badRequest('That code isn’t right.');
    const codes = newRecoveryCodes();
    await sql.begin(async (tx) => {
      await tx`delete from recovery_codes where user_id = ${req.user!.id}`;
      for (const c of codes) await tx`insert into recovery_codes (user_id, code_hash) values (${req.user!.id}, ${secrets.hash(normaliseRecoveryCode(c))})`;
      await audit(tx, { userId: req.user!.id, action: 'mfa_recovery_codes', entity: 'user', entityId: req.user!.id, ip: req.ip });
    });
    return { recoveryCodes: codes };
  });

  app.post('/api/auth/mfa/disable', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    if (!req.user) throw unauthorized();
    if (config.mfaRequired) throw forbidden('Two-factor sign-in is required on this server.');
    const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
    const [row] = await sql<{ passwordHash: string }[]>`select password_hash from users where id = ${req.user.id}`;
    if (!(await verify(row!.passwordHash, password).catch(() => false))) throw unauthorized('Password is incorrect');
    await sql`update users set totp_secret_enc = null, totp_enabled_at = null, totp_last_step = null where id = ${req.user.id}`;
    await sql`delete from recovery_codes where user_id = ${req.user.id}`;
    await audit(sql, { userId: req.user.id, action: 'mfa_disabled', entity: 'user', entityId: req.user.id, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = tokenFrom(req);
    if (token) await sql`delete from sessions where token_hash = ${sha256(token)}`;
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.user) throw unauthorized();
    return { user: req.user };
  });
}

// Hash of a random string, used to equalise timing for unknown emails.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(newToken());
  return dummyHash;
}

/** Route guard: `preHandler: requireRole('owner')`. No roles = any signed-in user. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw unauthorized();
    if (roles.length && !roles.includes(req.user.role)) throw forbidden();
  };
}

export function userOrThrow(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export async function createUser(db: Db, u: { name: string; email: string; password: string; role: Role }): Promise<{ id: string }> {
  const passwordHash = await hashPassword(u.password);
  const [row] = await db<{ id: string }[]>`
    insert into users (name, email, password_hash, role)
    values (${u.name}, ${u.email}, ${passwordHash}, ${u.role})
    returning id
  `;
  return row!;
}

/** Owners change things; site capture logs labour and costs; accountants only read. */
export const canWrite = (u: AuthUser) => u.role === 'owner';
export const seesMoney = (u: AuthUser) => u.role !== 'capture';
