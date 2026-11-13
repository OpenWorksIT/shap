/**
 * The app's screens call React's hooks (useState, useCallback, useAuthed…) only where React allows:
 * in the body of a component or another hook, never inside a callback, a button's action or an
 * effect. One that isn't throws when it runs ("Invalid hook call"), and the screen shows only
 * "Something went wrong": 1.10.1, where a stray useCallback inside an invoice's Send stopped every
 * invoice and quote from being shared since 1.1.0. Read straight from the source with TypeScript's
 * own parser, so it needs nothing else installed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '../../../apps/web/src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?)$/.test(f) && !/\.d\.ts$/.test(f) ? [p] : [];
  });
}

const isHook = (name: string) => /^use[A-Z0-9]/.test(name);
const isComponent = (name: string) => /^[A-Z]/.test(name);

/** The name a function goes by: its own, or the variable or property it's given to. */
function nameOf(fn: ts.SignatureDeclaration): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

/** A function React calls as a component or a hook: named so, or given to memo() or forwardRef(). */
function rendersHooks(fn: ts.SignatureDeclaration): boolean {
  const name = nameOf(fn);
  if (name && (isHook(name) || isComponent(name))) return true;
  const p = fn.parent;
  if (p && ts.isCallExpression(p)) {
    const callee = p.expression;
    const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    return called === 'memo' || called === 'forwardRef';
  }
  return false;
}

/** Each hook called somewhere React doesn't allow, as "file:line hook". */
export function misplacedHooks(path: string, source: string): string[] {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'React' ? callee.name.text : '';
      if (name && isHook(name)) {
        let fn: ts.Node | undefined = node.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        if (!fn || !rendersHooks(fn as ts.SignatureDeclaration)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          out.push(`${path.slice(WEB.length + 1)}:${line + 1} ${name}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('hooks only where React allows them', () => {
  it('finds a hook inside a button’s action (as Send had)', () => {
    const src = `export function Page() {\n  const send = () => run(async () => {\n    const pdf = useCallback(async () => 1, []);\n  });\n  return null;\n}\n`;
    expect(misplacedHooks(join(WEB, 'x.tsx'), src)).toEqual(['x.tsx:3 useCallback']);
    expect(misplacedHooks(join(WEB, 'y.tsx'), `export function Page() {\n  const [a] = useState(0);\n  return a;\n}\nexport const useThing = () => useMemo(() => 1, []);\n`)).toEqual([]);
  });

  it('none in the app’s screens', () => {
    const found = files(WEB).flatMap((f) => misplacedHooks(f, readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });
});
