import type { FastifyInstance } from 'fastify';
import { accountInput, attachmentInput, brandInput, categoryInput, entity, industryProfile, isTask, profileInput, settingsInput, settingsNumberProblem, sourceInput, TERMS_URL, tidyNumbers, tweaksFor, userInput, vatRateOn, withNeeds, workTypeInput, type Role } from '@shap/shared';
import { z } from 'zod';
import { accessOf, canAny, checkNewPassword, confirmPassword, createUser, endOtherSessions, hashPassword, requireAccess, requireRole, seesBooks, sessionToken, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import { pgCode, PG, type Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { applyBusinessType, getSettings, today } from '../lib/books.js';
import { checkInUsage } from './feedback.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { cleanImage } from '../lib/images.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * The cost types a kind of business needs (a salon's products and chair rent), added once and
 * listed first; a builder's demolition and PPE are hidden from the pickers for a designer. Hidden
 * ones stay on old costs and can be switched back on in Settings.
 */
export async function applyIndustry(db: Db, industry: string) {
  const p = industryProfile(industry);
  for (const [i, c] of p.categories.entries()) {
    await db`insert into cost_categories (name, kind, account_id, sort)
             select ${c.name}, ${c.kind}, a.id, ${i - 20} from accounts a where a.code = ${c.account}
             and not exists (select 1 from cost_categories x where lower(x.name) = lower(${c.name}))`;
  }
  const back = ['Demo', 'PPE', 'Vehicle Transfer', 'Tool'].filter((n) => !p.hide.includes(n));
  if (back.length) await db`update cost_categories set active = true where name in ${db(back)}`;
  if (p.hide.length) await db`update cost_categories set active = false where name in ${db(p.hide)} and not exists (select 1 from costs where category_id = cost_categories.id)`;
}


export async function referenceData(db: Db, money: boolean) {
  const [settings, sources, categories, workTypes, accounts, brands] = await Promise.all([
    getSettings(db),
    db`select s.id, s.name, s.kind, s.role, s.till, s.account_id, s.active, s.statements_required, s.statements_from, a.code as account_code, a.name as account_name
       from payment_sources s join accounts a on a.id = s.account_id order by s.sort, s.name`,
    db`select c.id, c.name, c.kind, c.account_id, c.active, a.code as account_code, a.name as account_name
       from cost_categories c join accounts a on a.id = c.account_id order by c.sort, c.name`,
    db`select id, name, active from work_types order by sort, name`,
    money ? db`select id, code, name, type, system_key, statement_line, active from accounts order by code` : Promise.resolve([]),
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

/**
 * A logo goes on every quote and invoice PDF, so it's decoded here and stored as a clean copy:
 * a damaged or crafted PNG is refused now, not found later by the PDF library.
 */
export function cleanLogo(input: z.infer<typeof attachmentInput>): z.infer<typeof attachmentInput> {
  const clean = cleanImage(Buffer.from(input.dataBase64, 'base64'));
  if (!clean) throw badRequest('That logo can’t be read. Save it again as a PNG or JPEG (up to 4096 pixels a side) and try again.');
  return { ...input, mime: clean[0] === 0xff ? 'image/jpeg' : 'image/png', dataBase64: clean.toString('base64') };
}

export async function saveAttachment(db: Db, input: z.infer<typeof attachmentInput>, createdBy: string): Promise<string> {
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.length === 0) throw badRequest('That file is empty');
  if (!SIGNATURES[input.mime]?.(bytes)) throw badRequest('That file isn’t a photo (JPEG, PNG, WebP) or a PDF');
  if (bytes.length > 6 * 1024 * 1024) throw badRequest('That file is too big (6 MB at most). Photos are shrunk on the phone before upload.');
  const [row] = await db<{ id: string }[]>`
    insert into attachments (filename, mime, size, bytes, created_by) values (${input.filename}, ${input.mime}, ${bytes.length}, ${bytes}, ${createdBy}) returning id
  `;
  return row!.id;
}

/** The file types attachments are uploaded as (schemas.ts attachmentInput, logos, statements). */
const SERVED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

/** Is there anything (the query's rows) on or before the lock date? No lock date: nothing is closed. */
async function postedInClosedYear(db: Db, query: () => PromiseLike<readonly unknown[]>): Promise<boolean> {
  const [s] = await db<{ lockDate: string | null }[]>`select lock_date from settings where id`;
  if (!s?.lockDate) return false;
  return (await query()).length > 0;
}

/** The whole of the company's settings: for those who see the books or make the quotes and invoices. */
const fullReference = (u: AuthUser) => seesBooks(u) || canAny(u, 'documents.view', 'documents.edit');

/** Only known tasks, with what they need. */
const cleanAccess = (keys: readonly string[]) => withNeeds(keys.filter(isTask));

/**
 * Where someone stands: staff on a profile (or none) with what's changed for them, kept as what
 * differs from the profile. Only staff have either.
 */
async function accessFields(db: Db, role: Role, profileId: string | null | undefined, access: readonly string[] | undefined) {
  if (role !== 'staff') return { profileId: null, accessAdd: [] as string[], accessRemove: [] as string[] };
  let base: string[] = [];
  if (profileId) {
    const [p] = await db<{ access: string[] }[]>`select access from profiles where id = ${profileId}`;
    if (!p) throw badRequest('That profile isn’t there any more. Choose another.');
    base = p.access;
  }
  const { add, remove } = tweaksFor(base, cleanAccess(access ?? base));
  return { profileId: profileId ?? null, accessAdd: add as string[], accessRemove: remove as string[] };
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/reference', { preHandler: requireRole() }, async (req) => {
    const user = userOrThrow(req);
    const full = fullReference(user);
    const ref = await referenceData(sql, seesBooks(user));
    if (!full) {
      // Staff who neither read the books nor make invoices see names, pickers and what's switched
      // on, not the company's numbering, terms or bank details.
      const s = ref.settings;
      return {
        ...ref,
        brands: ref.brands.map(({ bankDetails: _b, ...b }) => b),
        settings: {
          companyName: s.companyName, tradingName: s.tradingName, fyEndMonth: s.fyEndMonth, vatRegistered: s.vatRegistered, vatRateBp: s.vatRateBp,
          defaultCostSourceId: s.defaultCostSourceId, defaultWageSourceId: s.defaultWageSourceId, defaultReceiptSourceId: s.defaultReceiptSourceId, lockDate: s.lockDate,
          features: s.features, businessType: s.businessType, industry: s.industry, setupDone: s.setupDone,
        },
      };
    }
    return { ...ref, emailOn: Boolean(ctx.config.SMTP_URL) };
  });

  app.put('/api/settings', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(settingsInput, req.body);
    // Sole proprietors, partners and trusts are taxed on SARS's year ending in February.
    const kind = entity(input.businessType);
    if (kind.febYearEnd) input.fyEndMonth = 2;
    // Turnover tax and PBO approval only exist for the kinds of business that can have them.
    if (!kind.turnoverTax) input.turnoverTax = false;
    if (input.businessType !== 'npc') input.approvedPbo = false;
    // SARS: a company (CC, co-op) on turnover tax must have its year end on the last day of February
    // (TT01 FAQ). The 2026 Budget proposed dropping this; until the law changes, it stays.
    if (input.turnoverTax && input.fyEndMonth !== 2) throw badRequest('Turnover tax needs the year to end in February: change the financial year end first (SARS’s rule for companies on turnover tax).');
    const before = await getSettings(sql);
    // VAT, registration, tax and employer numbers: the right shape, and a VAT number to be registered for VAT.
    const numberProblem = settingsNumberProblem(input, before);
    if (numberProblem) throw badRequest(numberProblem.message);
    Object.assign(input, tidyNumbers(input));
    // The standard VAT rate is SARS's (vat.ts), not a setting: kept in step for anything that reads it.
    input.vatRateBp = vatRateOn(today());
    // A company's (or CC's) dividends are declared to SARS: the dividends section is always on for them.
    if (entity(input.businessType).dividendsTax) input.features = { ...input.features, dividends: true };
    // Stock is sold through sales: keeping inventory switches sales on.
    if (input.features?.inventory) input.features = { ...input.features, sales: true };
    // The lock date isn't a setting: it's locked and reopened under Accounts → Locks, by someone who
    // may close and reopen months and years (with the reason, in the audit log: periods.ts).
    delete (input as { lockDate?: unknown }).lockDate;
    // Accepting the terms: when, and in the audit log (below).
    const accepted = input.termsVersion && input.termsVersion !== before.termsVersion ? input.termsVersion : null;
    await sql.begin(async (tx) => {
      const row: Record<string, unknown> = { ...input, ...(accepted ? { termsAcceptedAt: new Date() } : {}), features: tx.json(input.features as never), logoLayout: tx.json(input.logoLayout as never), updatedAt: new Date() };
      for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
      await tx`update settings set ${tx(row as never)} where id`;
      // Selling at the counter takes money into the till: its account is there from then on.
      if ((input.features as Record<string, boolean> | undefined)?.sales) await tx`update payment_sources set active = true where till and not active`;
      await applyBusinessType(tx, input.businessType);
      if (input.industry && input.industry !== before.industry) await applyIndustry(tx, input.industry);
    });
    await audit(sql, { userId: user.id, action: 'update', entity: 'settings', ip: req.ip });
    if (accepted) await audit(sql, { userId: user.id, action: 'accept_terms', entity: 'settings', ip: req.ip, details: { version: accepted, url: TERMS_URL } });
    const saved = await getSettings(sql);
    // The usage note goes out if the answers changed (it remembers what it last sent).
    if (saved.usageConsent) void checkInUsage(ctx, sql, req.log).catch(() => undefined);
    return saved;
  });

  // ---- logo for quotes and invoices
  app.post('/api/settings/logo', { preHandler: requireRole('owner') }, async (req) => {
    const input = parse(attachmentInput, req.body);
    if (!input.mime.startsWith('image/png') && !input.mime.startsWith('image/jpeg')) throw badRequest('Use a PNG or JPEG logo');
    const id = await saveAttachment(sql, cleanLogo(input), userOrThrow(req).id);
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
      const [row] = await sql`insert into brands ${sql({ ...input, logoLayout: sql.json(input.logoLayout as never), sort: next!.n } as never)} returning *`;
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
      const [row] = await sql`update brands set ${sql({ ...input, logoLayout: sql.json(input.logoLayout as never) } as never)} where id = ${id} returning *`;
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
    const logoId = await saveAttachment(sql, cleanLogo(input), userOrThrow(req).id);
    await sql`update brands set logo_id = ${logoId} where id = ${id}`;
    return { logoId };
  });
  app.delete('/api/brands/:id/logo', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await sql`update brands set logo_id = null where id = ${id}`;
    return { ok: true };
  });

  // ---- files
  app.post('/api/attachments', { preHandler: requireAccess('costs.capture', 'costs.manage', 'stock.buy', 'bank.reconcile', 'books.adjust', 'documents.edit') }, async (req) => {
    const id = await saveAttachment(sql, parse(attachmentInput, req.body), userOrThrow(req).id);
    return { id };
  });
  app.get('/api/attachments/:id', { preHandler: requireRole() }, async (req, reply) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    // Staff open the files they uploaded themselves (their own slips); statements, logos and
    // everyone else's slips are for those who see the books. Authorising by the uploader — not by
    // "a cost points at this attachment" — stops anyone granting themselves access by pointing one
    // of their own costs at someone else's attachment id. Staff who see all the costs open the slips
    // on them too, but never a file that's also a bank statement, a logo or the financial statements.
    const slips = canAny(user, 'costs.view', 'costs.manage');
    const [row] = seesBooks(user)
      ? await sql<{ filename: string; mime: string; bytes: Buffer }[]>`select filename, mime, bytes from attachments where id = ${id}`
      : await sql<{ filename: string; mime: string; bytes: Buffer }[]>`
          select filename, mime, bytes from attachments a where a.id = ${id} and (a.created_by = ${user.id} or (${slips} and exists (select 1 from costs c where c.receipt_id = a.id)
            and not exists (select 1 from statement_files f where f.attachment_id = a.id) and not exists (select 1 from brands b where b.logo_id = a.id)
            and not exists (select 1 from settings st where st.logo_id = a.id)
            and not exists (select 1 from financial_statements fs where a.id in (fs.compiler_report_id, fs.final_pdf_id))))`;
    if (!row) throw notFound('File');
    // Only the kinds of file Shap takes in are served as themselves: anything else (from a doctored
    // backup, say) is handed over as plain bytes to save, never opened as a page.
    const safe = SERVED_TYPES.has(row.mime);
    reply.header('content-type', safe ? row.mime : 'application/octet-stream');
    reply.header('content-disposition', `${safe ? 'inline' : 'attachment'}; filename="${row.filename.replace(/[^\w.\- ]/g, '_')}"`);
    reply.header('cache-control', 'private, max-age=86400');
    // Belt-and-braces for a user-supplied file served inline: no scripts or plugins run even if a
    // client were ever to treat the bytes as a document (nosniff already forces the stored type).
    // Kept narrow (not default-src 'none') so the browser's inline image/PDF viewing still works.
    reply.header('content-security-policy', "script-src 'none'; object-src 'none'; frame-ancestors 'none'");
    return reply.send(row.bytes);
  });

  // ---- chart of accounts
  app.post('/api/accounts', { preHandler: requireRole('owner') }, async (req) => {
    const input = parse(accountInput, req.body);
    try {
      // No line given: the database picks one that fits the type (migration 038).
      const [row] = await sql`insert into accounts (code, name, type, statement_line, active) values (${input.code}, ${input.name}, ${input.type}, ${input.statementLine ?? null}, ${input.active}) returning *`;
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
    // Its type decides where its postings land (profit or the balance sheet): not for a closed year's.
    if (existing.type !== input.type && (await postedInClosedYear(sql, () => sql`select 1 from ledger l where l.account_id = ${id} and l.date <= (select lock_date from settings where id) limit 1`)))
      throw badRequest('This account has postings in a closed year, so its type can’t change. Make a new account for what’s coming instead.');
    try {
      // The line stays as it was unless one is given (or the type changed to one it doesn't fit).
      const [row] = input.statementLine
        ? await sql`update accounts set code = ${input.code}, name = ${input.name}, type = ${input.type}, statement_line = ${input.statementLine}, active = ${input.active} where id = ${id} returning *`
        : await sql`update accounts set code = ${input.code}, name = ${input.name}, type = ${input.type}, active = ${input.active} where id = ${id} returning *`;
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
      // Moving a cost type or a payment account to another account in the books moves everything
      // already captured with it: not what's in a closed year.
      if (input.accountId) {
        const [old] = await sql<{ accountId: string }[]>`select account_id from ${sql(table)} where id = ${id}`;
        const used = () =>
          table === 'cost_categories'
            ? sql`select 1 from costs where category_id = ${id} and date <= (select lock_date from settings where id) limit 1`
            : sql`select 1 from ledger l where l.account_id = ${old?.accountId ?? null} and l.date <= (select lock_date from settings where id) limit 1`;
        if (old && old.accountId !== input.accountId && (await postedInClosedYear(sql, used)))
          throw badRequest('What’s already captured with this goes to its account in a closed year, so the account can’t change. Make a new one for what’s coming instead.');
      }
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
    const rows = await sql<{ role: Role; profileAccess: string[] | null; accessAdd: string[]; accessRemove: string[] }[]>`
      select u.id, u.name, u.email, u.role, u.active, u.last_login_at, u.totp_enabled_at is not null as mfa,
        u.profile_id, p.name as profile_name, p.access as profile_access, u.access_add, u.access_remove
      from users u left join profiles p on p.id = u.profile_id order by u.name`;
    // What each can do now: their profile's, changed for them.
    return rows.map((r) => ({ ...r, access: accessOf(r) }));
  });
  app.post('/api/users', { preHandler: requireRole('owner') }, async (req) => {
    const me = userOrThrow(req);
    const input = parse(userInput, req.body);
    if (!input.password) throw badRequest('Set a starting password (at least 10 characters)');
    checkNewPassword(input.password, input);
    // Creating another owner is a takeover-grade action, so it takes the acting owner's password:
    // a session left open on a phone can't be used to mint a rival owner without it.
    if (input.role === 'owner') await confirmPassword(sql, me.id, input.currentPassword, req.ip);
    const access = await accessFields(sql, input.role, input.profileId, input.access);
    try {
      const u = await createUser(sql, { name: input.name, email: input.email, password: input.password, role: input.role, ...access });
      await audit(sql, { userId: me.id, action: 'create', entity: 'user', entityId: u.id, ip: req.ip, details: { role: input.role, profileId: access.profileId, add: access.accessAdd, remove: access.accessRemove } });
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
    const [target] = await sql<{ role: string }[]>`select role from users where id = ${id}`;
    if (!target) throw notFound('Someone');
    // Step-up re-authentication for the moves a stolen owner session could use to take over or
    // lock someone out: changing your own email/password (as before), resetting someone else's
    // password, making someone an owner, or editing an existing owner. Not just your own record.
    const stepUp =
      (id === me.id && (Boolean(input.password) || input.email !== me.email)) ||
      (id !== me.id && (Boolean(input.password) || input.role === 'owner' || target.role === 'owner'));
    if (stepUp) await confirmPassword(sql, me.id, input.currentPassword, req.ip);
    if (input.password) checkNewPassword(input.password, input);
    const access = await accessFields(sql, input.role, input.profileId, input.access);
    await sql.begin(async (tx) => {
      // An omitted `active` leaves it unchanged (so a PUT that doesn't resend active:false can't
      // silently re-enable a disabled sign-in).
      await tx`update users set name = ${input.name}, email = ${input.email}, role = ${input.role}, active = coalesce(${input.active ?? null}, active),
        profile_id = ${access.profileId}, access_add = ${access.accessAdd}, access_remove = ${access.accessRemove} where id = ${id}`;
      if (input.password) {
        await tx`update users set password_hash = ${await hashPassword(input.password)} where id = ${id}`;
        // Everyone signed in as them is signed out (you stay signed in, if it's yours).
        await endOtherSessions(tx, id, id === me.id ? sessionToken(req) : undefined);
      }
      if (input.active === false) await tx`delete from sessions where user_id = ${id}`;
      await audit(tx, { userId: me.id, action: 'update', entity: 'user', entityId: id, ip: req.ip, details: { role: input.role, profileId: access.profileId, add: access.accessAdd, remove: access.accessRemove, passwordReset: Boolean(input.password) } });
    });
    return { ok: true };
  });

  // ---- profiles: the jobs a kind of staff does, given to each person on it
  app.get('/api/profiles', { preHandler: requireRole('owner') }, async () =>
    sql`select p.id, p.name, p.access, (select count(*)::int from users u where u.profile_id = p.id) as people from profiles p order by lower(p.name)`);
  app.post('/api/profiles', { preHandler: requireRole('owner') }, async (req) => {
    const me = userOrThrow(req);
    const input = parse(profileInput, req.body);
    try {
      const [row] = await sql<{ id: string }[]>`insert into profiles (name, access) values (${input.name}, ${cleanAccess(input.access)}) returning id, name, access`;
      await audit(sql, { userId: me.id, action: 'create', entity: 'profile', entityId: row!.id, ip: req.ip, details: { name: input.name, access: cleanAccess(input.access) } });
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('There’s already a profile with that name');
      throw err;
    }
  });
  app.put('/api/profiles/:id', { preHandler: requireRole('owner') }, async (req) => {
    const me = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(profileInput, req.body);
    try {
      // Everyone on it gets the change at once (their own changes stay as they were).
      const [row] = await sql<{ id: string }[]>`update profiles set name = ${input.name}, access = ${cleanAccess(input.access)}, updated_at = now() where id = ${id} returning id, name, access`;
      if (!row) throw notFound('Profile');
      await audit(sql, { userId: me.id, action: 'update', entity: 'profile', entityId: id, ip: req.ip, details: { name: input.name, access: cleanAccess(input.access) } });
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('There’s already a profile with that name');
      throw err;
    }
  });
  app.delete('/api/profiles/:id', { preHandler: requireRole('owner') }, async (req) => {
    const me = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [used] = await sql<{ n: number }[]>`select count(*)::int as n from users where profile_id = ${id}`;
    if (used!.n) throw badRequest(`${used!.n === 1 ? 'Someone is' : `${used!.n} people are`} on this profile: give them another first.`);
    const [row] = await sql`delete from profiles where id = ${id} returning name`;
    if (!row) throw notFound('Profile');
    await audit(sql, { userId: me.id, action: 'delete', entity: 'profile', entityId: id, ip: req.ip, details: { name: row.name } });
    return { ok: true };
  });
  app.post('/api/users/:id/reset-mfa', { preHandler: requireRole('owner') }, async (req) => {
    const me = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    // Always takes the acting owner's password (a lost or borrowed phone shouldn't let anyone
    // reset someone's two-factor), and ends the target's sessions so a device that still holds one
    // can't keep access past the reset.
    await confirmPassword(sql, me.id, parse(z.object({ password: z.string().max(200).optional() }), req.body ?? {}).password, req.ip);
    await sql.begin(async (tx) => {
      await tx`update users set totp_secret_enc = null, totp_enabled_at = null, totp_last_step = null where id = ${id}`;
      await tx`delete from recovery_codes where user_id = ${id}`;
      if (id === me.id) await endOtherSessions(tx, id, sessionToken(req));
      else await tx`delete from sessions where user_id = ${id}`;
      await audit(tx, { userId: me.id, action: 'mfa_reset', entity: 'user', entityId: id, ip: req.ip });
    });
    return { ok: true };
  });

  /**
   * The audit log: who did what, when (it can't be changed or deleted, and it's in every backup).
   * Newest first, a page at a time (`before` an id), optionally for one kind of record or one person.
   */
  const auditQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    entity: z.string().max(40).regex(/^[a-z_]*$/).optional(),
    userId: z.string().uuid().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  });
  const auditRows = (q: Omit<z.infer<typeof auditQuery>, 'limit'>, limit: number) => sql<{ id: number; at: string; action: string; entity: string; entityId: string | null; details: Record<string, unknown>; userName: string | null; actor: string }[]>`
    select a.id, a.at, a.action, a.entity, a.entity_id, a.details, a.actor, u.name as user_name
    from audit_log a left join users u on u.id = a.user_id
    where true
      ${q.before ? sql`and a.id < ${q.before}` : sql``}
      ${q.entity ? sql`and a.entity = ${q.entity}` : sql``}
      ${q.userId ? sql`and a.user_id = ${q.userId}` : sql``}
      ${q.from ? sql`and a.at >= (${q.from}::date at time zone 'Africa/Johannesburg')` : sql``}
      ${q.to ? sql`and a.at < ((${q.to}::date + 1) at time zone 'Africa/Johannesburg')` : sql``}
    order by a.id desc limit ${limit}`;
  app.get('/api/audit', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const q = parse(auditQuery, req.query);
    const rows = await auditRows(q, q.limit + 1);
    const entities = await sql<{ entity: string }[]>`select distinct entity from audit_log order by 1`;
    return { items: rows.slice(0, q.limit), more: rows.length > q.limit, entities: entities.map((e) => e.entity) };
  });
  app.get('/api/audit.csv', { preHandler: requireRole('owner', 'accountant') }, async (req, reply) => {
    const q = parse(auditQuery.omit({ before: true, limit: true }), req.query);
    const rows = await auditRows(q, 100_000);
    const cell = (v: unknown) => {
      const t = String(v ?? '');
      // No cell may start a formula in a spreadsheet.
      const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
      return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [['When', 'Who', 'Action', 'Record', 'Record id', 'Details'].join(',')];
    for (const r of rows) lines.push([new Date(r.at).toISOString(), r.userName ?? r.actor, r.action, r.entity, r.entityId ?? '', JSON.stringify(r.details ?? {})].map(cell).join(','));
    await audit(sql, { userId: userOrThrow(req).id, action: 'export', entity: 'audit_log', ip: req.ip });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="shap-audit-log.csv"');
    return `${lines.join('\r\n')}\r\n`;
  });
}
