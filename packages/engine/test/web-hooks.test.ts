/**
 * The app's screens call React's hooks (useState, useCallback, useAuthed…) only where React allows:
 * in the body of a component or another hook, never inside a callback, a button's action or an
 * effect. One that isn't throws when it runs ("Invalid hook call"), and the screen showed only
 * "Something went wrong": 1.10.1, where a stray useCallback inside an invoice's Send stopped every
 * invoice and quote from being shared since 1.1.0. Read straight from the source with TypeScript's
 * own parser, so it needs nothing else installed. From the 1.10.1 review: a hook imported under
 * another name or called on any namespace counts, and a handler named like a component inside one
 * isn't one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '../../../apps/web/src');

function webFiles(dir = WEB): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? webFiles(p) : /\.(tsx?)$/.test(f) && !/\.d\.ts$/.test(f) ? [p] : [];
  });
}

const isHook = (name: string) => /^use[A-Z0-9]/.test(name);
const isComponent = (name: string) => /^[A-Z]/.test(name);

/** Through brackets, `as` and `satisfies`, to what they wrap's parent. */
function outer(node: ts.Node): ts.Node {
  let p = node.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p))) p = p.parent;
  return p;
}

/** The name a function goes by: its own, or the variable or property it's given to. */
function nameOf(fn: ts.SignatureDeclaration): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  const p = outer(fn);
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

/** Inside another function (not at the top of the file, or of something called there such as memo()). */
function nested(fn: ts.Node): boolean {
  for (let p = fn.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return true;
  return false;
}

/** A function React calls as a component or a hook. */
function rendersHooks(fn: ts.SignatureDeclaration): boolean {
  const name = nameOf(fn);
  // A hook is named use…; a component is named with a capital, at the top of the file (one inside
  // another function is a handler, whatever it's called). An unnamed default export is a component.
  if (name && isHook(name)) return true;
  if (name && isComponent(name)) return !nested(fn);
  if (!name && ts.isFunctionDeclaration(fn) && fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return true;
  const p = outer(fn);
  if (p && ts.isCallExpression(p)) {
    const callee = p.expression;
    const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    return (called === 'memo' || called === 'forwardRef') && !nested(p);
  }
  return false;
}

/** Each hook called somewhere React doesn't allow, as "file:line hook". */
export function misplacedHooks(path: string, source: string): string[] {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Hooks imported under another name: import { useCallback as uc } from 'react'.
  const aliases = new Map<string, string>();
  for (const st of sf.statements) {
    const named = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) if (el.propertyName && isHook(el.propertyName.text)) aliases.set(el.name.text, el.propertyName.text);
  }
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? (aliases.get(callee.text) ?? callee.text) : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
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
  const check = (src: string) => misplacedHooks(join(WEB, 'x.tsx'), src);
  it('finds a hook inside a button’s action (as Send had)', () => {
    expect(check(`export function Page() {\n  const send = () => run(async () => {\n    const pdf = useCallback(async () => 1, []);\n  });\n  return null;\n}\n`)).toEqual(['x.tsx:3 useCallback']);
    expect(check(`export function Page() {\n  const [a] = useState(0);\n  return a;\n}\nexport const useThing = () => useMemo(() => 1, []);\n`)).toEqual([]);
  });

  it('finds one under another name, on any namespace, or in a handler named like a component', () => {
    expect(check(`import { useCallback as uc } from 'react';\nexport function Page() {\n  const go = () => uc(() => 1, []);\n  return null;\n}\n`)).toEqual(['x.tsx:3 useCallback']);
    expect(check(`import * as R from 'react';\nexport function Page() {\n  const go = () => R.useCallback(() => 1, []);\n  return null;\n}\n`)).toEqual(['x.tsx:3 useCallback']);
    expect(check(`export function Page() {\n  const Send = async () => { useCallback(() => 1, []); };\n  run(async function Go() { useState(0); });\n  return null;\n}\n`)).toEqual(['x.tsx:2 useCallback', 'x.tsx:3 useState']);
  });

  it('takes a component however it’s written: unnamed default, wrapped, in memo()', () => {
    expect(check(`export default function () {\n  useState(0);\n  return null;\n}\n`)).toEqual([]);
    expect(check(`export const Page = ((p: P) => {\n  useState(0);\n  return null;\n}) as FC<P>;\n`)).toEqual([]);
    expect(check(`export const Row = memo(function (p: P) {\n  useState(0);\n  return null;\n});\n`)).toEqual([]);
  });

  it('none in the app’s screens', () => {
    const found = webFiles().flatMap((f) => misplacedHooks(f, readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });
});
