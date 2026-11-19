import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wuchale } from 'wuchale/vite';

/** Compile the existing Wuchale source pipeline once, preserving one public runtime across packages. */
export async function buildResourcePackage() {
  rmSync('dist', { recursive: true, force: true });
  const configPath = fileURLToPath(
    new URL('../wuchale.config.js', import.meta.url),
  );
  const localeLoader = fileURLToPath(
    new URL('../src/locales/main.loader.js', import.meta.url),
  );
  const translation = wuchale({ configPath });
  await translation.configResolved({ env: { DEV: false } });
  execFileSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve('typescript/bin/tsc')),
      '--emitDeclarationOnly',
    ],
    {
      stdio: 'inherit',
    },
  );
  const entries = readdirSync('src', { recursive: true })
    .filter(
      file =>
        /\.tsx?$/.test(file) && !/\.(test|testing|spec)\.|\.d\.ts$/.test(file),
    )
    .map(file => path.join('src', file));
  await build({
    entryPoints: entries,
    outdir: 'dist',
    outbase: 'src',
    packages: 'external',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: true,
    plugins: [
      {
        name: 'atomic-resource-localization',
        setup(builder) {
          builder.onLoad({ filter: /\.tsx?$/ }, async ({ path: filename }) => {
            const input = readFileSync(filename, 'utf8');
            const transformed = await translation.transform.handler(
              input,
              filename,
              {},
            );
            let contents = transformed?.code ?? input;
            // Preserve Vite's source-text imports in the standalone package.
            contents = contents.replace(
              /import\s+([\w$]+)\s+from\s*(['"])(\.[^'"]+)\?raw\2;?/g,
              (_match, identifier, _quote, asset) =>
                `const ${identifier} = ${JSON.stringify(readFileSync(path.resolve(path.dirname(filename), asset), 'utf8'))};`,
            );
            contents = contents.replace(
              /(['"])@wuchale\/jsx\/runtime\.jsx\1/g,
              '$1@tomic/resource-ui/locale-message$1',
            );
            contents = contents.replace(
              /from\s*(['"])([^'"]+)\1/g,
              (match, quote, specifier) =>
                path.resolve(path.dirname(filename), specifier) === localeLoader
                  ? `from ${quote}@tomic/resource-ui/locale-runtime${quote}`
                  : match,
            );

            return {
              contents,
              loader: filename.endsWith('.tsx') ? 'tsx' : 'ts',
              resolveDir: path.dirname(filename),
            };
          });
        },
      },
    ],
  });

  for (const file of readdirSync('src', { recursive: true })) {
    if (
      !/\.css$|\.[cm]?js$|\.d\.[cm]?ts$/.test(file) ||
      /\.(test|spec)\./.test(file)
    )
      continue;
    const target = path.join('dist', file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join('src', file), target);
  }

  if (
    path.resolve(process.cwd()) ===
    path.resolve(fileURLToPath(new URL('../', import.meta.url)))
  ) {
    const message = fileURLToPath(
      import.meta.resolve('@wuchale/jsx/runtime.jsx'),
    );
    copyFileSync(message, 'dist/locales/message.js');
    copyFileSync(
      path.join(path.dirname(message), 'runtime.d.ts'),
      'dist/locales/message.d.ts',
    );
  }
}
