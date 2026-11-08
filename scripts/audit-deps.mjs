#!/usr/bin/env node
/**
 * Known vulnerabilities in what the app ships (npm audit, production dependencies): high and
 * critical ones fail, unless accepted in .github/accepted-advisories.json with the reason it
 * can't hurt here and a date to look again (after which it fails again). Moderate ones are listed.
 *
 *   node scripts/audit-deps.mjs            # exit 1 if anything unaccepted is high or critical
 *
 * Used by CI (ci.yml) and the weekly dependency check (dependency-check.yml). docs/AUDIT.md.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

let out;
try {
  out = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  out = err.stdout; // npm audit exits 1 when it finds anything
}
const report = JSON.parse(out);
const accepted = existsSync('.github/accepted-advisories.json') ? JSON.parse(readFileSync('.github/accepted-advisories.json', 'utf8')).accepted ?? [] : [];
const today = new Date().toISOString().slice(0, 10);
const advisories = new Map();
for (const [name, v] of Object.entries(report.vulnerabilities ?? {}))
  for (const via of v.via) if (typeof via === 'object') advisories.set(via.url, { name, severity: via.severity, title: via.title, url: via.url, range: via.range });
let failed = 0;
const lines = [];
for (const a of [...advisories.values()].sort((x, y) => x.severity.localeCompare(y.severity))) {
  const id = a.url.split('/').pop();
  const ok = accepted.find((x) => x.id === id);
  const serious = a.severity === 'high' || a.severity === 'critical';
  if (serious && ok && ok.until >= today) lines.push(`ACCEPTED ${a.severity} ${a.name} ${id}: ${a.title} (until ${ok.until}: ${ok.reason})`);
  else if (serious) {
    failed++;
    lines.push(`FAIL     ${a.severity} ${a.name} ${id}: ${a.title} ${a.url}${ok ? ` (accepted until ${ok.until}: look again)` : ''}`);
  } else lines.push(`NOTE     ${a.severity} ${a.name} ${id}: ${a.title}`);
}
console.log(lines.length ? lines.join('\n') : 'No known vulnerabilities in the production dependencies.');
console.log(`\n${failed} to fix.`);
process.exitCode = failed ? 1 : 0;
