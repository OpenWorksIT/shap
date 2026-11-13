/**
 * From the reviews of Shap Pocket 1.10.1 (fixed in Shap 1.26.1 and Pocket 1.10.2), read from the
 * screens' source, the same in both apps:
 *
 * - An action that reports its own error (save(), run in a runner that catches and carries on)
 *   awaited inside another action: if it fails, the outer one goes ahead anyway. Send did this
 *   with save(): an edit the books refused, and Send still shared the PDF as last saved.
 * - The words for an error nobody expected: not "Something went wrong" (which told the owner
 *   nothing), from the screens or the books, and the error itself into Feedback's trail
 *   (console.error) so a bug report has it.
 * - Share PDF and Email on the document screen: they ask before sending a draft invoice or credit
 *   note, save first, record that it went out, and the delete warning knows. (The screens have no
 *   test harness: these read the wiring from the source; the rest is tested in
 *   review-1.26.1/send-drafts.test.ts.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
// TypeScript's own parser, from its 6.x package: TypeScript 7 (the compiler here) has no parser API yet.
import ts from '@typescript/typescript6';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '../../web/src');
/** The server's own code: its errors reach the screens word for word. */
const BOOKS = join(import.meta.dirname, '../src');
/** What Share PDF and Email go through on the document screen. */
const SEND = 'sendBy';

function webFiles(dir = WEB): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? webFiles(p) : /\.(tsx?)$/.test(f) && !/\.d\.ts$/.test(f) ? [p] : [];
  });
}
const parse = (path: string, source: string) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
const where = (path: string) => (path.startsWith(WEB) ? path.slice(WEB.length + 1) : `server/${path.slice(BOOKS.length + 1)}`);

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

/** "Something went wrong" said anywhere (in a string or a template), and each catch that shows UNEXPECTED without logging the error. */
export function unexpectedWords(path: string, source: string): string[] {
  const sf = parse(path, source);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    const text = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text : null;
    if (text !== null && /something went wrong/i.test(text)) out.push(`${where(path)}:${lineOf(sf, n)} “Something went wrong”`);
    // On a screen, the error itself goes to Feedback's trail (the server and the books log their own).
    if (path.startsWith(WEB) && ts.isCatchClause(n) && contains(n.block, (m) => ts.isIdentifier(m) && m.text === 'UNEXPECTED')) {
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
    const src = `function a() {\n  try { x(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Something went wrong'); }\n  try { x(); } catch (err) { toast(UNEXPECTED); }\n  try { x(); } catch (err) { console.error(err); toast(UNEXPECTED); }\n  throw new Error(\`Something went wrong (\${status})\`);\n  reply({ error: 'Something went wrong. Please try again.' });\n}\n`;
    expect(unexpectedWords(join(WEB, 'x.tsx'), src)).toEqual(['x.tsx:2 “Something went wrong”', 'x.tsx:3 UNEXPECTED without console.error', 'x.tsx:5 “Something went wrong”', 'x.tsx:6 “Something went wrong”']);
  });

  it('none in the app’s screens or the server', () => {
    expect([...webFiles(), ...webFiles(BOOKS)].flatMap((f) => unexpectedWords(f, readFileSync(f, 'utf8')))).toEqual([]);
  });
});

/** The function a `const name = …` holds in a source file. */
function constFn(sf: ts.SourceFile, name: string): ts.ArrowFunction | ts.FunctionExpression | null {
  let found: ts.ArrowFunction | ts.FunctionExpression | null = null;
  const visit = (n: ts.Node) => {
    if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = initFn(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
const calls = (node: ts.Node, name: string) => contains(node, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name);

describe('Share PDF and Email on the document screen', () => {
  const path = join(WEB, 'pages/Document.tsx');
  const sf = parse(path, readFileSync(path, 'utf8'));

  it('asks before sending a draft invoice or credit note, both ways', () => {
    const send = constFn(sf, SEND)!;
    expect(send, SEND).toBeTruthy();
    expect([calls(send, 'notIssuedYet'), calls(send, 'setAskIssue'), calls(send, 'persist')]).toEqual([true, true, true]);
    // The Email drawer opens only through it (or after its question), so a draft is asked about
    // and unsaved changes are saved first: Email used to open the drawer straight away.
    const opens: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'setDrawer' && n.arguments[0]?.getText(sf) === "'email'") {
        let p: ts.Node | undefined = n.parent;
        while (p && !(ts.isVariableDeclaration(p) && ts.isIdentifier(p.name))) p = p.parent;
        opens.push(p ? (p as ts.VariableDeclaration).name.getText(sf) : `line ${lineOf(sf, n)}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect([...new Set(opens)].sort()).toEqual(['sendAfterAsking', SEND].sort());
  });

  it('records that a share went out, and not a cancelled one', () => {
    const shareNow = constFn(sf, 'shareNow')!;
    expect(contains(shareNow, (n) => (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && n.getText(sf).includes('/shared'))).toBe(true);
    expect(contains(shareNow, (n) => ts.isStringLiteral(n) && n.text === 'cancelled')).toBe(true);
    const files = parse(join(WEB, 'lib/files.ts'), readFileSync(join(WEB, 'lib/files.ts'), 'utf8'));
    const abort = (n: ts.Node) => ts.isIfStatement(n) && n.expression.getText(files).includes("'AbortError'");
    expect(contains(files, (n) => abort(n) && contains((n as ts.IfStatement).thenStatement, (m) => ts.isStringLiteral(m) && m.text === 'cancelled'))).toBe(true);
  });

  it('warns before deleting one that has gone out, from what the server records (sentAt)', () => {
    expect(webFiles().filter((f) => readFileSync(f, 'utf8').includes('sharedAt')).map(where)).toEqual([]);
    const sent: string[] = [];
    const visit = (n: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === 'DeleteRecord')
        for (const a of n.attributes.properties) if (ts.isJsxAttribute(a) && a.name.getText(sf) === 'sent') sent.push(a.initializer?.getText(sf) ?? '');
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(sent).toEqual(['{hasGoneOut(doc)}']);
  });
});
