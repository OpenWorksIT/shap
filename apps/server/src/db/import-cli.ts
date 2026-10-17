/**
 * Import a project tracker workbook from the command line:
 *   npm run import -- path/to/tracker.xlsx [--replace] [--no-trial-balance] [--dry-run] [--company company.json]
 * --company loads a Shap company file (trading names, clients, agreed year ends) after the tracker.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { formatZar, monthLabel } from '@shap/shared';
import { loadConfig } from '../config.js';
import { applyTracker } from '../modules/import/apply.js';
import { restoreCompanyFile } from '../modules/company-file.js';
import { readTracker } from '../modules/import/tracker.js';
import { createDb } from './index.js';
import { migrate } from './migrate.js';

const argAfter = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const companyPath = argAfter('company');
const file = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== companyPath);
const flag = (f: string) => process.argv.includes(`--${f}`);
if (!file) {
  console.error('Usage: npm run import -- path/to/tracker.xlsx [--replace] [--no-trial-balance] [--dry-run]');
  process.exit(1);
}

const plan = await readTracker(await readFile(file));
console.log(`Read ${plan.projects.length} jobs, ${plan.costs.length} costs, ${plan.labour.length} labour days, ${plan.wagePayments.length} wage payments, ${plan.workers.length} workers.`);
for (const w of plan.warnings) console.log(`  ! ${w}`);
if (flag('dry-run')) process.exit(0);

const sql = createDb(loadConfig().DATABASE_URL, { max: 2 });
try {
  await migrate(sql);
  const r = await applyTracker(sql, plan, {
    replace: flag('replace'),
    agreeTrialBalance: !flag('no-trial-balance'),
  });
  console.log('Imported:', r.counts);
  if (companyPath) {
    const restored = await sql.begin((tx) => restoreCompanyFile(tx, JSON.parse(readFileSync(companyPath, 'utf8'))));
    console.log('Company file loaded:', restored);
  }
  for (const w of r.warnings.slice(plan.warnings.length)) console.log(`  ! ${w}`);
  if (r.agreement) {
    console.log(`Agreed to the trial balance at ${r.agreement.date}:`);
    for (const l of r.agreement.lines) console.log(`  ${l.account.padEnd(24)} ${formatZar(l.amountCents)}`);
  }
  console.log(`Jobs checked against Per Project: ${r.jobsChecked}, differing by more than R1: ${r.jobDifferences.length}`);
  for (const j of r.jobDifferences) console.log(`  ${j.name} ${j.field}: sheet ${formatZar(j.sheetCents)}, Shap ${formatZar(j.shapCents)}`);
  const off = r.checks.filter((c) => c.sheet.invoicedCents !== c.shap.invoicedCents || c.sheet.partsCents !== c.shap.partsCents || c.sheet.labourCents !== c.shap.labourCents);
  console.log(off.length ? 'Months that differ from the Trade Statement:' : 'Every month agrees with the Trade Statement.');
  for (const c of off) {
    const d = (a: number, b: number) => (a === b ? '' : `${formatZar(a)} vs ${formatZar(b)}`);
    console.log(`  ${monthLabel(c.month)}  invoiced ${d(c.sheet.invoicedCents, c.shap.invoicedCents) || 'ok'} · parts ${d(c.sheet.partsCents, c.shap.partsCents) || 'ok'} · labour ${d(c.sheet.labourCents, c.shap.labourCents) || 'ok'}`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
