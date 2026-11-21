import ts from 'typescript';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const browser = fileURLToPath(new URL('../../', import.meta.url));
const failures = [];
const importsByFile = new Map();
let checked = 0;

for (const owner of ['resource-ui', 'table-page', 'ui']) {
  const root = path.join(browser, owner, 'src');

  for (const file of readdirSync(root, { recursive: true })) {
    if (
      !/\.[jt]sx?$/.test(file) ||
      /\.(test|testing|spec)\.|\.d\.ts$/.test(file)
    )
      continue;
    const filename = path.join(root, file);
    const source = ts.createSourceFile(
      filename,
      readFileSync(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    const imports = [];

    const inspect = node => {
      const spec =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;

      if (spec && ts.isStringLiteral(spec)) {
        const value = spec.text;
        imports.push(value);
        if (
          value.startsWith('@atomic-shell/') ||
          /^@(components|chunks|helpers|hooks|views)\//.test(value)
        )
          failures.push(`${owner}/${file}: host import ${value}`);
        if (owner === 'resource-ui' && value.startsWith('@tomic/table-page'))
          failures.push(
            `${owner}/${file}: resource UI depends on its consumer`,
          );
        if (
          owner === 'ui' &&
          /^@tomic\/(react|lib|resource-ui|table-page)(\/|$)/.test(value)
        )
          failures.push(`${owner}/${file}: generic UI depends on SDK/page`);

        if (value.startsWith('.')) {
          const resolved = path.resolve(
            path.dirname(filename),
            value.split('?')[0],
          );
          if (!resolved.startsWith(root + path.sep))
            failures.push(
              `${owner}/${file}: relative import leaves package source: ${value}`,
            );
          const candidates = [
            resolved,
            resolved.replace(/\.js$/, '.ts'),
            resolved.replace(/\.js$/, '.tsx'),
          ];
          if (!value.includes('/.wuchale/') && !candidates.some(existsSync))
            failures.push(`${owner}/${file}: missing source ${value}`);
        }
      }

      ts.forEachChild(node, inspect);
    };

    inspect(source);
    importsByFile.set(filename, imports);
    checked++;
  }
}

// Starting the locale download must not evaluate React or a UI/SDK package.
const pending = [
  path.join(browser, 'resource-ui/src/helpers/preloadLocale.ts'),
];
const visited = new Set();

while (pending.length) {
  const filename = pending.pop();
  if (visited.has(filename)) continue;
  visited.add(filename);

  for (const spec of importsByFile.get(filename) ?? []) {
    if (!spec.startsWith('.')) {
      if (!['wuchale/runtime', 'wuchale/load-utils/pure'].includes(spec))
        failures.push(`Locale preload imports a non-pure dependency: ${spec}`);
      continue;
    }

    const resolved = path.resolve(path.dirname(filename), spec);
    const target = [
      resolved,
      resolved.replace(/\.js$/, '.ts'),
      resolved.replace(/\.js$/, '.tsx'),
    ].find(existsSync);
    if (target) pending.push(target);
  }
}

if (failures.length) throw new Error(failures.join('\n'));
console.log(
  `Checked ${checked} production modules: no host imports, missing local sources or package cycles; locale preload stays React-free.`,
);
