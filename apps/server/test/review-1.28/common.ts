/** Shared bits for the tests of the 1.28 reviews' findings (CPDAUDIT.md): made-up books only. */
import { balance, expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';
import { buildStatements } from '../../src/statements/build.js';
export { balance, expectCleanAudit, login, setup, buildStatements, type TestEnv };

export const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
export const file = (name: string, text: string, asAt?: string) => ({ name, dataBase64: b64(text), ...(asAt ? { asAt } : {}) });

let n = 0;
export function caller(me: Awaited<ReturnType<typeof login>>) {
  // Each call from its own address, so the routes' rate limits don't count them together.
  const post = async <T = any>(url: string, payload: unknown): Promise<T> => {
    const r = await me.call({ method: 'POST', url, payload: payload as never, remoteAddress: `10.97.${(++n >> 8) & 255}.${n & 255}` });
    if (r.statusCode >= 400) throw new Error(`POST ${url} → ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const attempt = (url: string, payload: unknown, method: 'POST' | 'PUT' | 'DELETE' = 'POST') => me.call({ method, url, payload: payload as never, remoteAddress: `10.98.${(++n >> 8) & 255}.${n & 255}` });
  /** Read, take Shap's suggestions (new accounts of the file's type), with `chosen` by name overriding, then apply. */
  const bring = async (files: ReturnType<typeof file>[], chosen: Record<string, string> = {}, newTypes: Record<string, string> = {}) => {
    const { accounts } = await post('/api/books-import/read', { files });
    const mapping = accounts.map((a: any) => ({ code: a.code, name: a.name, accountId: chosen[a.name] ?? a.accountId, newType: chosen[a.name] ? null : (newTypes[a.name] ?? a.type ?? null) }));
    return post('/api/books-import/apply', { files, mapping });
  };
  return { post, attempt, bring };
}

export const acc = async (env: TestEnv, key: string) => (await env.sql<{ id: string }[]>`select id from accounts where system_key = ${key}`)[0]!.id;
export const R = (c: number) => (c / 100).toFixed(2);

/** A made-up company's Xero trial balance at 28 February 2026 (YTD columns are the figures). */
export const XERO_TB_2026 = `Trial Balance
Made-up Kestrel Plumbing (Pty) Ltd
As at 28 February 2026
Account,Account Code,Account Type,Debit,Credit,YTD Debit,YTD Credit
Business Bank Account,090,Bank,,,"50,000.00",
Accounts Receivable,610,Current Asset,,,"30,000.00",
Office Equipment,710,Fixed Asset,,,"80,000.00",
Less Accumulated Depreciation on Office Equipment,711,Fixed Asset,,,,"20,000.00"
Accounts Payable,800,Current Liability,,,,"15,000.00"
Loan - Made-up Bank,900,Non-current Liability,,,,"40,000.00"
Share Capital,970,Equity,,,,"1,000.00"
Retained Earnings,960,Equity,,,,"69,000.00"
Sales,200,Revenue,,,,"300,000.00"
Cost of Goods Sold,310,Direct Costs,,,"120,000.00",
Wages and Salaries,477,Expense,,,"150,000.00",
Depreciation,416,Depreciation,,,"10,000.00",
Interest Expense,437,Expense,,,"5,000.00",
Total,,,,,"445,000.00","445,000.00"
`;
