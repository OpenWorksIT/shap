/**
 * From the reviews of Shap Pocket 1.10.1 (fixed in Shap 1.26.1 and Pocket 1.10.2), two more things
 * read from the screens' source, the same in both apps:
 *
 * - An action that reports its own error (save(), run in a runner that catches and carries on)
 *   awaited inside another action: if it fails, the outer one goes ahead anyway. Send did this
 *   with save(): an edit the books refused, and Send still shared the PDF as last saved.
 * - The words for an error nobody expected: not "Something went wrong" (which told the owner
 *   nothing), and the error itself into Feedback's trail (console.error) so a bug report has it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '../../web/src');

function webFiles(dir = WEB): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? webFiles(p) : /\.(tsx?)$/.test(f) && !/\.d\.ts$/.test(f) ? [p] : [];
  });
}
const parse = (path: string, source: string) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
const where = (path: string) => path.slice(WEB.length + 1);

function contains(node: ts.Node, test: (n: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (test(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The function a `const name = …` holds, through brackets. */
function initFn(d: ts.VariableDeclaration): ts.ArrowFunction | ts.FunctionExpression | null {
  let e = d.initializer;
  while (e && ts.isParenthesizedExpression(e)) e = e.expression;
  return e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) ? e : null;
}

/**
 * Each action awaited inside another, as "file:line inner in runner". A runner takes a function and
 * runs it in a try whose catch doesn't throw again (it shows the error and carries on); an action is
 * a function that hands its work to a runner.
 */
export function actionsInActions(path: string, source: string): string[] {
  const sf = parse(path, source);
  const decls: ts.VariableDeclaration[] = [];
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && initFn(n)) decls.push(n);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  // Calls the function it was given inside a try whose catch doesn't throw it on.
  const swallows = (fn: ts.ArrowFunction | ts.FunctionExpression) => {
    const params = new Set(fn.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])));
    const callsParam = (n: ts.Node) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && params.has(n.expression.text);
    return contains(fn.body, (n) => ts.isTryStatement(n) && Boolean(n.catchClause) && contains(n.tryBlock, callsParam) && !contains(n.catchClause!, ts.isThrowStatement));
  };
  const runners = new Set(decls.filter((d) => swallows(initFn(d)!)).map((d) => (d.name as ts.Identifier).text));
  const callsRunner = (n: ts.Node) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && runners.has(n.expression.text);
  const actions = new Set(decls.filter((d) => !runners.has((d.name as ts.Identifier).text) && contains(initFn(d)!.body, callsRunner)).map((d) => (d.name as ts.Identifier).text));
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (callsRunner(n)) {
      const call = n as ts.CallExpression;
      const runner = (call.expression as ts.Identifier).text;
      for (const arg of call.arguments) {
        const inner = (m: ts.Node) => {
          if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && actions.has(m.expression.text)) out.push(`${where(path)}:${lineOf(sf, m)} ${m.expression.text} in ${runner}`);
          ts.forEachChild(m, inner);
        };
        inner(arg);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** "Something went wrong" said anywhere, and each catch that shows UNEXPECTED without logging the error. */
export function unexpectedWords(path: string, source: string): string[] {
  const sf = parse(path, source);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.trim() === 'Something went wrong') out.push(`${where(path)}:${lineOf(sf, n)} “Something went wrong”`);
    if (ts.isCatchClause(n) && contains(n.block, (m) => ts.isIdentifier(m) && m.text === 'UNEXPECTED')) {
      const logs = contains(n.block, (m) => ts.isCallExpression(m) && ts.isPropertyAccessExpression(m.expression) && m.expression.getText(sf) === 'console.error');
      if (!logs) out.push(`${where(path)}:${lineOf(sf, n)} UNEXPECTED without console.error`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('the screens’ actions', () => {
  it('finds an action that reports its own error awaited inside another (as Send did with save)', () => {
    const src = `export function Page() {
  const run = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (err) { setError(String(err)); }
  };
  const save = () => run(async () => { await api('/save'); });
  const share = () =>
    run(async () => {
      if (dirty) await save();
      await shareFile();
    });
  const persist = async () => { await api('/save'); };
  const send = () => run(async () => { await persist(); await shareFile(); });
  return null;
}
`;
    expect(actionsInActions(join(WEB, 'x.tsx'), src)).toEqual(['x.tsx:8 save in run']);
  });

  it('none in the app’s screens', () => {
    expect(webFiles().flatMap((f) => actionsInActions(f, readFileSync(f, 'utf8')))).toEqual([]);
  });
});

describe('the words for an error nobody expected', () => {
  it('finds “Something went wrong”, and UNEXPECTED shown without the error going in the trail', () => {
    const src = `function a() {\n  try { x(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Something went wrong'); }\n  try { x(); } catch (err) { toast(UNEXPECTED); }\n  try { x(); } catch (err) { console.error(err); toast(UNEXPECTED); }\n}\n`;
    expect(unexpectedWords(join(WEB, 'x.tsx'), src)).toEqual(['x.tsx:2 “Something went wrong”', 'x.tsx:3 UNEXPECTED without console.error']);
  });

  it('none in the app’s screens', () => {
    expect(webFiles().flatMap((f) => unexpectedWords(f, readFileSync(f, 'utf8')))).toEqual([]);
  });
});
