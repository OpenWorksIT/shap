/**
 * The Shap Pocket share's format (Shap's docs/ACCOUNTANT.md, "A Shap Pocket share"): the whole of
 * a one-person business's books from their phone, stamped. Pocket makes it (its engine,
 * modules/share.ts); Shap reads it (apps/server/src/modules/import/pocket-share.ts). One schema,
 * the same in both, so what Pocket makes is what Shap reads: every field limited, since the file
 * comes from outside.
 */
import { z } from 'zod';
import { BUSINESS_TYPES } from './entities.js';
import { ACCOUNT_TYPES } from './enums.js';
import { VAT_CATEGORIES } from './tax.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().max(max).default('');

export const POCKET_SHARE_FORMAT = 'shap-pocket-share/1';

export const pocketShareSchema = z.object({
  format: z.literal(POCKET_SHARE_FORMAT),
  stamp: z.object({
    number: z.number().int().positive(),
    madeAt: z.string().max(40),
    through: date,
    previous: z.object({ number: z.number().int().positive(), madeAt: z.string().max(40) }).nullable(),
    app: z.literal('Shap Pocket'),
  }),
  business: z.object({
    companyName: text(200),
    tradingName: text(200),
    businessType: z.enum(BUSINESS_TYPES),
    fyEndMonth: z.number().int().min(1).max(12),
    vatRegistered: z.boolean(),
    vatCategory: z.enum(VAT_CATEGORIES),
    vatNumber: text(30),
    turnoverTax: z.boolean(),
    approvedPbo: z.boolean(),
  }),
  accounts: z.array(z.object({ code: z.string().min(1).max(30), name: z.string().min(1).max(200), type: z.enum(ACCOUNT_TYPES) })).max(2000),
  transactions: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        date,
        source: z.string().max(40),
        reference: text(120),
        description: text(300),
        lines: z.array(z.object({ code: z.string().min(1).max(30), cents: z.number().int().safe(), memo: text(300) })).min(1).max(500),
      }),
    )
    .max(200_000),
  changes: z.object({ added: z.array(z.string().max(200)), changed: z.array(z.string().max(200)), removed: z.array(z.string().max(200)) }),
  totals: z.object({ transactions: z.number().int().nonnegative(), debitsCents: z.number().int().nonnegative() }),
});
export type PocketShare = z.infer<typeof pocketShareSchema>;
