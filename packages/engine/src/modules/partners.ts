/**
 * A partnership's partners (packages/shared/src/entities.ts).
 *
 * Each partner has two accounts of their own: a capital account (what they put into the
 * partnership) and a current account (their share of each year's profit, less what they take
 * out: drawings are recorded against it, like a sole proprietor's against theirs). Each also
 * has a share of profit and loss.
 *
 * At a year end the year's profit (or loss) is shared between them by those shares: one journal
 * dated the last day of the year moves it out of "Profit not yet shared between partners" (the
 * retained earnings account, which collects every year's profit until it's shared) into their
 * current accounts. Shared again (the figures changed), the journal is replaced; it respects
 * the lock date like everything else.
 */
import { addMonths, entity, financialYear, splitByShares } from '@shap/shared';
import { z } from 'zod';
import type { App as FastifyInstance } from '../http.js';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db, Tx } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, freshTotals, getSettings, isIsoDate, today } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });

export const partnerInput = z.object({
  name: z.string().trim().min(1, 'Give the partner’s name').max(120),
  /** Share of profit and loss in basis points: 5000 = 50%. */
  shareBp: z.number().int().min(0).max(10000),
  active: z.boolean().default(true),
});

export interface PartnerRow {
  id: string;
  name: string;
  shareBp: number;
  active: boolean;
  capitalAccountId: string;
  currentAccountId: string;
  capitalCents: number;
  currentCents: number;
}

const capitalName = (name: string) => `Capital: ${name}`;
const currentName = (name: string) => `Current account: ${name}`;
const paidName = (name: string) => `Paid personally (${name})`;

/** The partners, with what's in their accounts (credit balances shown as positive). */
export async function listPartners(db: Db): Promise<PartnerRow[]> {
  await freshTotals(db);
  return db<PartnerRow[]>`
    select p.id, p.name, p.share_bp, p.active, p.capital_account_id, p.current_account_id,
      -coalesce((select sum(l.amount_cents) from ledger_totals l where l.account_id = p.capital_account_id), 0)::bigint as capital_cents,
      -coalesce((select sum(l.amount_cents) from ledger_totals l where l.account_id = p.current_account_id), 0)::bigint as current_cents
    from partners p order by p.created_at`;
}

/** The next free account code in a range (3300–3399 capital, 3400–3499 current accounts). */
async function nextCode(tx: Tx, from: number, to: number): Promise<string> {
  const used = new Set((await tx<{ code: string }[]>`select code from accounts`).map((r) => r.code));
  for (let c = from; c <= to; c++) if (!used.has(String(c))) return String(c);
  throw badRequest('There’s no room for more partners’ accounts');
}

/** The financial year a profit share is for: the one ending on `fyEnd`, or the last one that has ended. */
function yearFor(fyEndMonth: number, fyEnd?: string) {
  if (fyEnd && isIsoDate(fyEnd)) return financialYear(fyEnd, fyEndMonth);
  const now = financialYear(today(), fyEndMonth);
  return financialYear(addMonths(now.start, -1), fyEndMonth);
}

/** A year's profit (income less costs; negative for a loss), before anything is shared. */
async function yearProfit(db: Db, from: string, to: string): Promise<number> {
  await freshTotals(db);
  const [r] = await db<{ t: number }[]>`
    select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger_totals l join accounts a on a.id = l.account_id
    where a.type in ('income', 'cost_of_sales', 'expense') and l.date between ${from}::date and ${to}::date`;
  return -Number(r!.t);
}

export function registerPartnerRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const readers = { preHandler: requireRole('owner', 'accountant') };
  const owner = { preHandler: requireRole('owner') };
  const mustBePartnership = async () => {
    const s = await getSettings(sql);
    if (s.businessType !== 'partnership') throw badRequest('Partners are for a partnership: choose it under Settings → Your business first.');
    return s;
  };

  app.get('/api/partners', readers, async () => ({ partners: await listPartners(sql) }));

  app.post('/api/partners', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(partnerInput, req.body);
    await mustBePartnership();
    const id = await sql.begin(async (tx) => {
      const cap = await nextCode(tx, 3300, 3399);
      const [capital] = await tx<{ id: string }[]>`insert into accounts (code, name, type) values (${cap}, ${capitalName(input.name)}, 'equity') returning id`;
      const cur = await nextCode(tx, 3400, 3499);
      const [current] = await tx<{ id: string }[]>`insert into accounts (code, name, type) values (${cur}, ${currentName(input.name)}, 'equity') returning id`;
      const [p] = await tx<{ id: string }[]>`
        insert into partners (name, share_bp, active, capital_account_id, current_account_id)
        values (${input.name}, ${input.shareBp}, ${input.active}, ${capital!.id}, ${current!.id}) returning id`;
      // What a partner pays for the business themselves goes onto their own current account.
      await tx`insert into payment_sources (name, kind, account_id, active, sort) values (${paidName(input.name)}, 'owner', ${current!.id}, ${input.active}, 50)`;
      return p!.id;
    });
    await audit(sql, { userId: user.id, action: 'create', entity: 'partner', entityId: id, ip: req.ip });
    return { id };
  });

  app.put('/api/partners/:id', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(partnerInput, req.body);
    const [old] = await sql<{ name: string; capitalAccountId: string; currentAccountId: string }[]>`select name, capital_account_id, current_account_id from partners where id = ${id}`;
    if (!old) throw notFound('Partner');
    await sql.begin(async (tx) => {
      await tx`update partners set name = ${input.name}, share_bp = ${input.shareBp}, active = ${input.active} where id = ${id}`;
      // The accounts follow a new name, unless someone renamed them themselves.
      await tx`update accounts set name = ${capitalName(input.name)} where id = ${old.capitalAccountId} and name = ${capitalName(old.name)}`;
      await tx`update accounts set name = ${currentName(input.name)} where id = ${old.currentAccountId} and name = ${currentName(old.name)}`;
      await tx`update payment_sources set name = case when name = ${paidName(old.name)} then ${paidName(input.name)} else name end, active = ${input.active} where account_id = ${old.currentAccountId} and kind = 'owner'`;
    });
    await audit(sql, { userId: user.id, action: 'update', entity: 'partner', entityId: id, ip: req.ip });
    return { ok: true };
  });

  /** A year's profit, how it would be (or was) shared, and whether it has been. */
  app.get('/api/partners/profit-share', readers, async (req) => {
    const s = await getSettings(sql);
    const fy = yearFor(s.fyEndMonth, (req.query as { fyEnd?: string }).fyEnd);
    const partners = (await listPartners(sql)).filter((p) => p.active);
    const profitCents = await yearProfit(sql, fy.start, fy.end);
    const [posted] = await sql<{ journalId: string; profitCents: number; createdAt: string; shares: { name: string; shareBp: number; cents: number }[] }[]>`select journal_id, profit_cents, created_at, shares from profit_shares where fy_end = ${fy.end}`;
    const totalBp = partners.reduce((t, p) => t + p.shareBp, 0);
    return {
      fy,
      profitCents,
      totalBp,
      parts: splitByShares(profitCents, partners).map((x) => ({ partnerId: x.partner.id, name: x.partner.name, shareBp: x.partner.shareBp, cents: x.cents })),
      posted: posted ?? null,
      locked: Boolean(s.lockDate && s.lockDate >= fy.end),
    };
  });

  app.post('/api/partners/profit-share', owner, async (req) => {
    const user = userOrThrow(req);
    const s = await mustBePartnership();
    const { fyEnd } = parse(z.object({ fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body);
    const fy = yearFor(s.fyEndMonth, fyEnd);
    if (fy.end >= today()) throw badRequest('That year hasn’t ended yet: share its profit once it has.');
    await assertOpen(sql, fy.end);
    const partners = (await listPartners(sql)).filter((p) => p.active);
    if (!partners.length) throw badRequest('Add the partners first');
    if (partners.reduce((t, p) => t + p.shareBp, 0) !== 10000) throw badRequest('The partners’ shares must add up to 100%');
    const profit = await yearProfit(sql, fy.start, fy.end);
    const parts = splitByShares(profit, partners);
    const journalId = await sql.begin(async (tx) => {
      const [old] = await tx<{ journalId: string }[]>`select journal_id from profit_shares where fy_end = ${fy.end}`;
      if (old) await tx`delete from journals where id = ${old.journalId}`;
      const [re] = await tx<{ id: string }[]>`select id from accounts where system_key = 'retained_earnings'`;
      const [j] = await tx<{ id: string }[]>`
        insert into journals (date, description, kind, created_by)
        values (${fy.end}, ${`Profit for ${fy.label} shared between the partners`}, 'profit_share', ${user.id}) returning id`;
      const line = async (accountId: string, cents: number, memo: string) => {
        if (!cents) return;
        // A profit is credited to the partners (debited from the unshared profit); a loss the other way.
        await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
          values (${j!.id}, ${accountId}, ${cents < 0 ? -cents : 0}, ${cents > 0 ? cents : 0}, ${memo})`;
      };
      await line(re!.id, -profit, profit >= 0 ? 'Profit shared' : 'Loss shared');
      for (const p of parts) await line(p.partner.currentAccountId, p.cents, `${(p.partner.shareBp / 100).toLocaleString('en-ZA')}% share`);
      const shares = parts.map((p) => ({ name: p.partner.name, shareBp: p.partner.shareBp, cents: p.cents }));
      await tx`insert into profit_shares (fy_end, journal_id, profit_cents, shares, created_by) values (${fy.end}, ${j!.id}, ${profit}, ${tx.json(shares as never)}, ${user.id})`;
      return j!.id;
    });
    await audit(sql, { userId: user.id, action: 'create', entity: 'profit_share', entityId: journalId, ip: req.ip, details: { fyEnd: fy.end, profitCents: profit } });
    return { journalId, profitCents: profit };
  });

  app.delete('/api/partners/profit-share/:fyEnd', owner, async (req) => {
    const user = userOrThrow(req);
    const { fyEnd } = parse(z.object({ fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.params);
    await assertOpen(sql, fyEnd);
    const [old] = await sql<{ journalId: string }[]>`select journal_id from profit_shares where fy_end = ${fyEnd}`;
    if (!old) throw notFound('Profit share');
    await sql`delete from journals where id = ${old.journalId}`;
    await audit(sql, { userId: user.id, action: 'delete', entity: 'profit_share', entityId: old.journalId, ip: req.ip });
    return { ok: true };
  });
}

/** For the year end and Home: is last year's profit still to be shared? */
export const entityNeedsProfitShare = (businessType: string) => entity(businessType).taxedAs === 'partners';
