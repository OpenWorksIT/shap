/**
 * The routes in Shap's code, read from apps/server/src: `app.get('/api/…'` and the like, and those
 * a helper makes for several lists (`app.post(`/api/${path}`` inside `const simpleList = (path…`),
 * filled in from the helper's calls. The penetration test calls every one; the security tests
 * check this finds exactly the routes Fastify has (apps/server/test/security.test.ts).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));

/** `{ routes: Set of "METHOD /api/path", unread: routes written in a way this can't fill in }` */
export function routesInCode(srcDir) {
  const routes = new Set();
  const unread = [];
  for (const f of files(srcDir)) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/app\.(get|post|put|delete|patch)\(\s*(['"`])(\/api\/[^'"`]*)\2/g)) {
      const method = m[1].toUpperCase();
      const path = m[3];
      if (!path.includes('${')) {
        routes.add(`${method} ${path}`);
        continue;
      }
      // The helper the route is in, its parameter, and what each call passes for it.
      const before = text.slice(0, m.index);
      const helper = [...before.matchAll(/const (\w+) = (?:<[^>]*>)?\(\s*(\w+)\s*:/g)].pop();
      const filled = helper ? [...text.matchAll(new RegExp(`\\b${helper[1]}\\(\\s*'([^']+)'`, 'g'))].map((c) => path.replaceAll(`\${${helper[2]}}`, c[1])) : [];
      if (!filled.length || filled.some((p) => p.includes('${'))) unread.push(`${method} ${path} (${f.slice(srcDir.length + 1)})`);
      else for (const p of filled) routes.add(`${method} ${p}`);
    }
  }
  return { routes, unread };
}
