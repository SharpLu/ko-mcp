/** Resolve shared Hono handlers without flattening mutually exclusive views.
 * Deliberately bounded static analysis: follow URLSearchParams through named
 * helpers, bind literal arguments, and prune literal control flow. Unknown
 * request values explore both branches. Unknown helpers/keys fail closed.
 * Every traversed source file must be included in the upstream blob pin.
 */
import ts from 'typescript';
import { posix } from 'node:path';

const UNKNOWN = Symbol('unknown');
const SEARCH_PARAMS = Symbol('URLSearchParams');
export function sharedQueryReads(rootFile, sourceOf) {
  const modules = new Map();
  const files = new Set();
  const reads = new Set();
  const stack = new Set();
  function moduleAt(file) {
    if (modules.has(file)) return modules.get(file);
    const ast = ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (ast.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
    const mod = { file, ast, functions: new Map(), imports: new Map() };
    modules.set(file, mod);
    files.add(file);
    for (const s of ast.statements) {
      if (ts.isFunctionDeclaration(s) && s.name) mod.functions.set(s.name.text, s);
      if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) mod.functions.set(d.name.text, d.initializer);
      }
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
        const bindings = s.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const b of bindings.elements) {
          mod.imports.set(b.name.text, { path: s.moduleSpecifier.text, name: (b.propertyName ?? b.name).text });
        }
      }
    }
    return mod;
  }
  function resolveFunction(mod, name) {
    if (mod.functions.has(name)) return [mod, mod.functions.get(name)];
    const imported = mod.imports.get(name);
    if (!imported) throw new Error(`Unresolved query helper ${name} in ${mod.file}`);
    const path = imported.path.startsWith('@/') ? `src/${imported.path.slice(2)}` :
      imported.path.startsWith('.') ? posix.join(posix.dirname(mod.file), imported.path) : null;
    if (!path) throw new Error(`External query helper ${name} is unsupported`);
    return resolveFunction(moduleAt(path.replace(/\.js$/, '.ts')), imported.name);
  }
  function invoke(mod, fn, args) {
    const key = `${mod.file}:${fn.pos}`;
    if (stack.has(key)) throw new Error(`Recursive query helper in ${mod.file}`);
    stack.add(key);
    const env = new Map();
    fn.parameters.forEach((p, i) => {
      if (!ts.isIdentifier(p.name)) throw new Error('Destructured query-helper arguments are unsupported');
      env.set(p.name.text, args[i] ?? UNKNOWN);
    });
    try {
      if (!fn.body) throw new Error('Query helper has no body');
      if (ts.isBlock(fn.body)) scan(fn.body, env, mod);
      else expr(fn.body, env, mod);
    } finally { stack.delete(key); }
    return UNKNOWN;
  }
  function expr(n, env, mod) {
    if (!n) return UNKNOWN;
    if (ts.isIdentifier(n)) return env.get(n.text) ?? UNKNOWN;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n)) return expr(n.expression, env, mod);
    if (ts.isPropertyAccessExpression(n)) {
      if (n.name.text === 'searchParams') return SEARCH_PARAMS;
      if (expr(n.expression, env, mod) === SEARCH_PARAMS) throw new Error(`Unsupported URLSearchParams property ${n.name.text}`);
      return UNKNOWN;
    }
    if (ts.isConditionalExpression(n)) {
      const condition = expr(n.condition, env, mod);
      if (condition !== UNKNOWN) return expr(condition ? n.whenTrue : n.whenFalse, env, mod);
      expr(n.whenTrue, env, mod); expr(n.whenFalse, env, mod); return UNKNOWN;
    }
    if (ts.isBinaryExpression(n)) {
      const left = expr(n.left, env, mod), op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && left === false) return false;
      if (op === ts.SyntaxKind.BarBarToken && left === true) return true;
      const right = expr(n.right, env, mod);
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment && left !== UNKNOWN) throw new Error('Assignment to a bound query-helper argument is unsupported');
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && right === false) return false;
      if (op === ts.SyntaxKind.BarBarToken && right === true) return true;
      if (left === SEARCH_PARAMS || right === SEARCH_PARAMS) throw new Error('Unsupported URLSearchParams assignment/expression');
      if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
      if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return left && right;
      if (op === ts.SyntaxKind.BarBarToken) return left || right;
      return UNKNOWN;
    }
    if (ts.isPrefixUnaryExpression(n)) {
      const value = expr(n.operand, env, mod);
      return n.operator === ts.SyntaxKind.ExclamationToken && value !== UNKNOWN ? !value : UNKNOWN;
    }
    if (ts.isCallExpression(n)) {
      const args = n.arguments.map(a => expr(a, env, mod));
      if (ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const receiver = expr(n.expression.expression, env, mod);
        const contextRead = /^c\.req\.(query|queries)$/.test(n.expression.getText(mod.ast));
        if (receiver === SEARCH_PARAMS || contextRead) {
          if (!contextRead && !['get', 'getAll', 'has'].includes(method)) throw new Error(`Unsupported URLSearchParams method ${method}`);
          if (typeof args[0] !== 'string') throw new Error('Query key must resolve to a literal');
          reads.add(args[0]); return UNKNOWN;
        }
      }
      if (args.includes(SEARCH_PARAMS)) {
        if (!ts.isIdentifier(n.expression)) throw new Error('Unsupported indirect query helper');
        const [target, fn] = resolveFunction(mod, n.expression.text);
        return invoke(target, fn, args);
      }
      // Scan chained expressions (value(sp, 'period')?.toUpperCase(), etc.).
      if (!ts.isPropertyAccessExpression(n.expression)) expr(n.expression, env, mod);
      return UNKNOWN;
    }
    // Callback reads are part of the caller. Their runtime data is unknown.
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const nested = new Map(env);
      for (const p of n.parameters) if (ts.isIdentifier(p.name)) nested.set(p.name.text, UNKNOWN);
      if (ts.isBlock(n.body)) scan(n.body, nested, mod); else expr(n.body, nested, mod);
      return UNKNOWN;
    }
    ts.forEachChild(n, child => {
      if (expr(child, env, mod) === SEARCH_PARAMS) throw new Error('Unsupported URLSearchParams escape');
    });
    return UNKNOWN;
  }
  // true means unconditional termination of this branch, not of an unknown sibling.
  function scan(n, env, mod) {
    if (ts.isBlock(n)) { for (const s of n.statements) if (scan(s, env, mod)) return true; return false; }
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        const value = expr(d.initializer, env, mod);
        if (ts.isIdentifier(d.name)) env.set(d.name.text, value);
        else if (value === SEARCH_PARAMS) throw new Error('Destructured URLSearchParams is unsupported');
      }
      return false;
    }
    if (ts.isIfStatement(n)) {
      const condition = expr(n.expression, env, mod);
      if (condition !== UNKNOWN) return condition ? scan(n.thenStatement, env, mod) : n.elseStatement ? scan(n.elseStatement, env, mod) : false;
      const a = scan(n.thenStatement, new Map(env), mod);
      const b = n.elseStatement ? scan(n.elseStatement, new Map(env), mod) : false;
      return a && b;
    }
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
      if (expr(n.expression, env, mod) === SEARCH_PARAMS) throw new Error('Returning URLSearchParams is unsupported');
      return true;
    }
    if (ts.isTryStatement(n)) {
      const a = scan(n.tryBlock, env, mod);
      const b = n.catchClause ? scan(n.catchClause.block, new Map(env), mod) : true;
      if (n.finallyBlock) scan(n.finallyBlock, env, mod);
      return a && b;
    }
    if (ts.isExpressionStatement(n)) { expr(n.expression, env, mod); return false; }
    // Fail closed when new control flow could alter the set of query reads.
    if (ts.isSwitchStatement(n) || ts.isIterationStatement(n, false) || ts.isFunctionDeclaration(n)) throw new Error('Unsupported shared-handler control flow');
    expr(n, env, mod); return false;
  }
  const root = moduleAt(rootFile);
  const handlers = [];
  for (const statement of root.ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(root.ast) !== 'app') continue;
    const [path, callback] = call.arguments;
    if (!path || !ts.isStringLiteral(path) || !callback || !ts.isArrowFunction(callback) || !ts.isCallExpression(callback.body) || !ts.isIdentifier(callback.body.expression)) throw new Error('Unsupported shared route wrapper');
    if (callback.body.arguments.slice(1).some(a => !ts.isStringLiteral(a))) throw new Error('Shared route view must be a literal');
    const [mod, fn] = resolveFunction(root, callback.body.expression.text);
    reads.clear();
    invoke(mod, fn, callback.body.arguments.map(a => expr(a, new Map(), root)));
    handlers.push({ method: call.expression.name.text.toUpperCase(), path: path.text, readParams: [...reads].sort() });
  }
  if (!handlers.length) throw new Error('No shared route handlers found');
  return { handlers, files: [...files] };
}
