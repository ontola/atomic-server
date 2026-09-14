import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(
  new URL('../.dagger/package.json', import.meta.url),
);
const ts = require('typescript');

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@dagger.io/dagger') {
    return {
      shortCircuit: true,
      url: new URL('./dagger-test-sdk.mjs', import.meta.url).href,
    };
  }
  if (specifier.startsWith('./') && !specifier.endsWith('.ts')) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // The specifier may refer to a JavaScript module; let Node resolve it.
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const source = await readFile(new URL(url), 'utf8');
    return {
      shortCircuit: true,
      format: 'module',
      source: ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          experimentalDecorators: true,
        },
      }).outputText,
    };
  }
  return nextLoad(url, context);
}
