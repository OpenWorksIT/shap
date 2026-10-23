import type { FastifyInstance } from 'fastify';
import {
  accountInput,
  attachmentInput,
  brandInput,
  categoryInput,
  settingsInput,
  sourceInput,
  userInput,
  workTypeInput,
} from '@shap/shared';
import { z } from 'zod';
import { checkNewPassword, confirmPassword, createUser, endOtherSessions, hashPassword, requireRole, seesMoney, sessionToken, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { pgCode, PG, type Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/books.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });

export async function referenceData(db: Db, money: boolean) {
  const [settings, sources, categories, workTypes, accounts, brands] = await Promise.all([
    getSettings(db),
    db`select s.id, s.name, s.kind, s.account_id, s.active, s.statements_required, s.statements_from, a.code as account_code, a.name as account_name
       from payment_sources s join accounts a on a.id = s.account_id order by s.sort, s.name`,
    db`select c.id, c.name, c.kind, c.account_id, c.active, a.code as account_code, a.name as account_name
       from cost_categories c join accounts a on a.id = c.account_id order by c.sort, c.name`,
    db`select id, name, active from work_types order by sort, name`,
    money ? db`select id, code, name, type, system_key, active from accounts order by code` : Promise.resolve([]),
    db`select * from brands order by active desc, sort, name`,
  ]);
  return { settings, sources, categories, workTypes, accounts, brands };
}

/** Saves an uploaded file (receipt photo, logo). Returns its id. */
/** The first bytes each allowed kind of file starts with: a file must be what it says it is. */
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};

export async function saveAttachment(db: Db, input: z.infer<typeof attachmentInput>): Promise<string> {
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.length === 0) throw badRequest('That file is empty');
  if (!SIGNATURES[input.mime]?.(bytes)) throw badRequest('That file isn’t a photo (JPEG, PNG, WebP) or a PDF');
  if (bytes.length > 6 * 1024 * 1024) throw badRequest('That file is too big (6 MB at most). Photos are shrunk on the phone before upload.');
  const [row] = await db<{ id: string }[]>`
    insert into attachments (filename, mime, size, bytes) values (${input.filename}, ${input.mime}, ${bytes.length}, ${bytes}) returning id
  `;
  return row!.id;
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/reference', { preHandler: requireRole() }, async (req) => {
    const user = userOrThrow(req);
    const ref = await referenceData(sql, seesMoney(user));
    if (!seesMoney(user)) {
      // Site capture sees names and pickers, not the company's numbering or bank details.
      const s = ref.settings;
      return { ...ref, brands: ref.brands.map(({ bankDetails: _b, ...b }) => b), settings: { companyName: s.companyName, tradingName: s.tradingName, fyEndMonth: s.fyEndMonth, vatRegistered: s.vatRegistered, vatRateBp: s.vatRateBp, defaultCostSourceId: s.defaultCostSourceId, defaultWageSourceId: s.defaultWageSourceId, defaultReceiptSourceId: s.defaultReceiptSourceId, lockDate: s.lockDate } };
    }
    return ref;
  });

  app.put('/api/settings', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(settingsInput, req.body);
    await sql`update settings set ${sql({ ...input, lockDate: input.lockDate ?? null, updatedAt: new Date() } as never)} where id`;
    await audit(sql, { userId: user.id, action: 'update', entity: 'settings', ip: req.ip });
    return getSettings(sql);
  });

  // ---- logo for quotes and invoices
  app.post('/api/settings/logo', { preHandler: requireRole('owner') }, async (req) => {
    const input = parse(attachmentInput, req.body);
    if (!input.mime.startsWith('image/png') && !input.mime.startsWith('image/jpeg')) throw badRequest('Use a PNG or JPEG logo');
    const id = await saveAttachment(sql, input);
    await sql`update settings set logo_id = ${id} where id`;
    return { logoId: id };
  });
  app.delete('/api/settings/logo', { preHandler: requireRole('owner') }, async () => {
    await sql`update settings set logo_id = null where id`;
    return { ok: true };
  });

  // ---- trading names
  app.post('/api/brands', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(brandInput, req.body);
    try {
      const [next] = await sql<{ n: number }[]>`select coalesce(max(sort), 0) + 1 as n from brands`;
      const [row] = await sql`insert into brands ${sql({ ...input, sort: next!.n })} returning *`;
      await audit(sql, { userId: user.id, action: 'create', entity: 'brand', entityId: row!.id, ip: req.ip });
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('There’s already a trading name called that');
      throw err;
    }
  });
  app.put('/api/brands/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(brandInput, req.body);
    try {
      const [row] = await sql`update brands set ${sql(input)} where id = ${id} returning *`;
      if (!row) throw notFound('Trading name');
      await audit(sql, { userId: user.id, action: 'update', entity: 'brand', entityId: id, ip: req.ip });
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('There’s already a trading name called that');
      throw err;
    }
  });
  app.post('/api/brands/:id/logo', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(attachmentInput, req.body);
    if (input.mime !== 'image/png' && input.mime !== 'image/jpeg') throw badRequest('Use a PNG or JPEG logo');
    const logoId = await saveAttachment(sql, input);
    await sql`update brands set logo_id = ${logoId} where id = ${id}`;
    return { logoId };
  });
  app.delete('/api/brands/:id/logo', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await sql`update brands set logo_id = null where id = ${id}`;
    return { ok: true };
  });

  // ---- files
  app.post('/api/attachments', { preHandler: requireRole('owner', 'capture') }, async (req) => {
    const id = await saveAttachment(sql, parse(attachmentInput, req.body));
    return { id };
  });
  app.get('/api/attachments/:id', { preHandler: requireRole() }, async (req, reply) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    // Site capture opens the slips on costs they captured; statements and the rest are for the owner and accountant.
    const [row] = seesMoney(user)
      ? await sql<{ filename: string; mime: string; bytes: Buffer }[]>`select filename, mime, bytes from attachments where id = ${id}`
      : await sql<{ filename: string; mime: string; bytes: Buffer }[]>`select a.filename, a.mime, a.bytes from attachments a
          where a.id = ${id} and exists (select 1 from costs c where c.receipt_id = a.id and c.created_by = ${user.id})`;
    if (!row) throw notFound('File');
    reply.header('content-type', row.mime);
    reply.header('content-disposition', `inline; filename="${row.filename.replace(/[^\w.\- ]/g, '_')}"`);
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(row.bytes);
  });

  // ---- chart of accounts
  app.post('/api/accounts', { preHandler: requireRole('owner') }, async (req) => {
    const input = parse(accountInput, req.body);
    try {
      const [row] = await sql`insert into accounts ${sql(input)} returning *`;
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('An account with that code already exists');
      throw err;
    }
  });
  app.put('/api/accounts/:id', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(accountInput, req.body);
    const [existing] = await sql<{ systemKey: string | null; type: string }[]>`select system_key, type from accounts where id = ${id}`;
    if (!existing) throw notFound('Account');
    if (existing.systemKey && existing.type !== input.type) throw badRequest('Shap posts to this account automatically, so its type can’t change. You can rename it.');
    try {
      const [row] = await sql`update accounts set ${sql(input)} where id = ${id} returning *`;
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('An account with that code already exists');
      throw err;
    }
  });

  // ---- payment sources, cost categories, general work types
  const simpleList = <S extends z.ZodTypeAny>(path: string, table: string, schema: S) => {
    app.post(`/api/${path}`, { preHandler: requireRole('owner') }, async (req) => {
      const input = parse(schema, req.body) as Record<string, unknown>;
      try {
        const [row] = await sql`insert into ${sql(table)} ${sql(input)} returning *`;
        return row;
      } catch (err) {
        if (pgCode(err) === PG.uniqueViolation) throw conflict('That name is already used');
        throw err;
      }
    });
    app.put(`/api/${path}/:id`, { preHandler: requireRole('owner') }, async (req) => {
      const { id } = parse(idParam, req.params);
      const input = parse(schema, req.body) as Record<string, unknown>;
      try {
        const [row] = await sql`update ${sql(table)} set ${sql(input)} where id = ${id} returning *`;
        if (!row) throw notFound();
        return row;
      } catch (err) {
        if (pgCode(err) === PG.uniqueViolation) throw conflict('That name is already used');
        throw err;
      }
    });
  };
  simpleList('sources', 'payment_sources', sourceInput);
  simpleList('categories', 'cost_categories', categoryInput);
  simpleList('work-types', 'work_types', workTypeInput);

  // ---- users
  app.get('/api/users', { preHandler: requireRole('owner') }, async () => {
    return sql`select id, name, email, role, active, last_login_at, totp_enabled_at is not null as mfa from users order by name`;
  });
  app.post('/api/users', { preHandler: requireRole('owner') }, async (req) => {
    const me = userOrThrow(req);
    const input = parse(userInput, req.body);
    if (!input.password) throw badRequest('Set a starting password (at least 10 characters)');
    checkNewPassword(input.password, input);
    try {
      const u = await createUser(sql, { name: input.name, email: input.email, password: input.password, role: input.role });
      await audit(sql, { userId: me.id, action: 'create', entity: 'user', entityId: u.id, ip: req.ip, details: { role: input.role } });
      return u;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('Someone already signs in with that email');
      throw err;
    }
  });
  app.put('/api/users/:id', { preHandler: requireRole('owner') }, async (req) => {
    const me = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(userInput, req.body);
    if (id === me.id && (input.role !== 'owner' || input.active === false)) throw badRequest('You can’t remove your own owner access');
    // Your own email or password: your current password too, so an open session left on a
    // phone can't be used to lock you out of your own books.
    if (id === me.id && (input.password || input.email !== me.email)) await confirmPassword(sql, me.id, input.currentPassword, req.ip);
    if (input.password) checkNewPassword(input.password, input);
    await sql.begin(async (tx) => {
      await tx`update users set name = ${input.name}, email = ${input.email}, role = ${input.role}, active = ${input.active ?? true} where id = ${id}`;
      if (input.password) {
        await tx`update users set password_hash = ${await hashPassword(input.password)} where id = ${id}`;
        // Everyone signed in as them is signed out (you stay signed in, if it's yours).
        await endOtherSessions(tx, id, id === me.id ? sessionToken(req) : undefined);
      }
      if (input.active === false) await tx`delete from sessions where user_id = ${id}`;
      await audit(tx, { userId: me.id, action: 'update', entity: 'user', entityId: id, ip: req.ip, details: { role: input.role, passwordReset: Boolean(input.password) } });
    });
    return { ok: true };
  });
  app.post('/api/users/:id/reset-mfa', { preHandler: requireRole('owner') }, async (req) => {
    const me = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    if (id === me.id) await confirmPassword(sql, me.id, parse(z.object({ password: z.string().max(200).optional() }), req.body ?? {}).password, req.ip);
    await sql`update users set totp_secret_enc = null, totp_enabled_at = null, totp_last_step = null where id = ${id}`;
    await sql`delete from recovery_codes where user_id = ${id}`;
    await audit(sql, { userId: me.id, action: 'mfa_reset', entity: 'user', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/audit', { preHandler: requireRole('owner', 'accountant') }, async () => {
    return sql`select a.at, a.action, a.entity, a.entity_id, a.details, u.name as user_name
               from audit_log a left join users u on u.id = a.user_id order by a.id desc limit 300`;
  });
}
