// The import specifiers of a package's build (build-package.mjs), rewritten by the compiler as it
// emits, so only real ones change: an import or export declaration's module, a dynamic `import('...')`
// with a literal, and an `import('...')` type in a declaration. Text that looks like one (in a string,
// a comment, a template) is never touched. A relative specifier written as the workspace writes it
// (`'./check'`, `'../kb'`) becomes one Node resolves (`'./check.js'`, `'../kb/index.js'`), from the
// TypeScript file it names; a JSON module's import gets `with { type: 'json' }`.
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const isFile = (path) => existsSync(path) && statSync(path).isFile();

/**
 * The specifier `spec`, written in the source file `from`, as Node resolves it from the build; the
 * same specifier when it needs no change (a package, or a file named with its extension); or null when
 * it names nothing (a mistake, which the build reports).
 */
export function resolvedSpecifier(spec, from, exists = isFile) {
  if (!spec.startsWith('./') && !spec.startsWith('../') && spec !== '.' && spec !== '..') return spec;
  const target = resolve(dirname(from), spec);
  if (/\.(js|mjs|cjs|json)$/.test(spec)) return exists(target) || exists(target.replace(/\.js$/, '.ts')) ? spec : null;
  if (exists(`${target}.ts`)) return `${spec}.js`;
  if (exists(`${target}/index.ts`)) return `${spec.replace(/\/$/, '')}/index.js`;
  return null;
}

/**
 * The compiler's transformers for `ts` (the typescript module): `before` for the JavaScript and
 * `afterDeclarations` for the .d.ts files. Each specifier that names nothing is passed to `unresolved`.
 */
export function specifierTransformers(ts, { exists = isFile, unresolved = () => {} } = {}) {
  const make = (declarations) => (context) => (root) => {
    const f = context.factory;
    const from = root.fileName ?? root.sourceFiles?.[0]?.fileName;
    const literal = (node) => {
      const next = resolvedSpecifier(node.text, from, exists);
      if (next === null) {
        unresolved(`${from}: ${node.text}`);
        return node;
      }
      return next === node.text ? node : f.createStringLiteral(next, true);
    };
    const jsonType = () => f.createImportAttributes(f.createNodeArray([f.createImportAttribute(f.createIdentifier('type'), f.createStringLiteral('json', true))]));
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = literal(node.moduleSpecifier);
        const attributes = !declarations && node.attributes === undefined && spec.text.endsWith('.json') ? jsonType() : node.attributes;
        return f.updateImportDeclaration(node, node.modifiers, node.importClause, spec, attributes);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        return f.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, literal(node.moduleSpecifier), node.attributes);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
        return f.updateCallExpression(node, node.expression, node.typeArguments, [literal(node.arguments[0]), ...node.arguments.slice(1).map((a) => ts.visitNode(a, visit))]);
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        return f.updateImportTypeNode(node, f.updateLiteralTypeNode(node.argument, literal(node.argument.literal)), node.attributes, node.qualifier, node.typeArguments ? f.createNodeArray(node.typeArguments.map((t) => ts.visitNode(t, visit))) : undefined, node.isTypeOf);
      }
      return ts.visitEachChild(node, visit, context);
    };
    if (ts.isBundle?.(root)) return root;
    return ts.visitNode(root, visit);
  };
  return { before: [make(false)], afterDeclarations: [make(true)] };
}

/** `code` (a TypeScript module at `fileName`) as the build emits its JavaScript: for tests of the transformer. */
export function emitModule(ts, code, fileName, exists) {
  const problems = [];
  const out = ts.transpileModule(code, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
    transformers: { before: specifierTransformers(ts, { exists, unresolved: (p) => problems.push(p) }).before },
  });
  return { code: out.outputText, unresolved: problems };
}
