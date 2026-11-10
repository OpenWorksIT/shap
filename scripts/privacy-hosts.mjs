#!/usr/bin/env node
/**
 * Every outside address written in the app's code, against .github/hosts.json: each one is
 * either somewhere the app sends requests ("sends": what goes there, and on whose say-so) or
 * only a link shown to people or a source cited in a comment ("link"). A new address fails until
 * it's put on the list, so a tracker, an analytics service or any new place data could go can't
 * slip in unnoticed. CPDAUDIT.md.
 *
 *   node scripts/privacy-hosts.mjs
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const list = JSON.parse(readFileSync('.github/hosts.json', 'utf8'));
const known = new Map(list.hosts.map((h) => [h.host, h]));
const files = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? (f === 'node_modules' || f === 'dist' ? [] : files(p)) : /\.(ts|tsx|mjs|js|html)$/.test(f) ? [p] : [];
      })
    : [];
const roots = ['apps', 'packages'].flatMap((r) => (existsSync(r) ? readdirSync(r).map((d) => join(r, d, 'src')) : []));
const found = new Map();
for (const f of [...roots.flatMap(files), ...files('apps/web').filter((p) => p.endsWith('index.html'))])
  for (const m of readFileSync(f, 'utf8').matchAll(/https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)) {
    const h = m[1].toLowerCase();
    if (/^(localhost|example\.(com|co\.za|org)|[a-z0-9-]+\.example|www\.w3\.org)$/.test(h) || h.endsWith('.example')) continue;
    if (!found.has(h)) found.set(h, f);
  }
const unknown = [...found].filter(([h]) => !known.has(h));
for (const [h, f] of [...found].sort()) {
  const k = known.get(h);
  console.log(`${k ? (k.kind === 'sends' ? 'SENDS ' : 'LINK  ') : 'NEW   '} ${h}${k ? `: ${k.why}` : ` (first seen in ${f}): add it to .github/hosts.json, saying whether the app sends anything there`}`);
}
console.log(`\n${unknown.length} new.`);
process.exitCode = unknown.length ? 1 : 0;
