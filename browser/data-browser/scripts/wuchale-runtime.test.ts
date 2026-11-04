import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, Hub, type Config } from 'wuchale';
import appConfig from '../wuchale.config.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true })));
});

/** Transforms `source` with the app's real `main` adapter (heuristic + runtime). */
async function transform(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'atomic-wuchale-runtime-'));
  roots.push(root);
  await mkdir(join(root, 'src/locales'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const file = join(root, 'src/example.tsx');
  await writeFile(file, source);
  const config: Config = {
    ...defaultConfig,
    locales: ['en'],
    ai: null,
    adapters: { main: appConfig.adapters!.main! },
  };
  const hub = await Hub.create('build', () => config, root);
  const [output] = await hub.transform(source, file);

  return (output as { code?: string }).code ?? '';
}

/** The body of the `{ ... }` block that follows `header`, for crude per-function assertions. */
function bodyAfter(code: string, header: string) {
  const start = code.indexOf(header);
  expect(start, `${header} in output`).toBeGreaterThan(-1);
  let depth = 0;

  for (let i = code.indexOf('{', start); i < code.length; i++) {
    if (code[i] === '{') depth++;
    if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1);
  }

  return code.slice(start);
}

describe('Wuchale runtime', () => {
  // Wuchale names methods `ClassName.method`; its default runtime saw the
  // uppercase first letter and called a React hook in the constructor, so
  // `new FooError()` outside a render threw React error #321.
  it('does not call a hook in class methods', async () => {
    const code = await transform(`
export class FooError extends Error {
  constructor() {
    super('Some readable text');
  }

  describe() {
    return 'Another readable text';
  }
}

export function FooView() {
  return <p>Visible component text</p>;
}
`);

    const constructorBody = bodyAfter(code, 'constructor()');
    const methodBody = bodyAfter(code, 'describe()');
    const component = bodyAfter(code, 'function FooView()');

    expect(constructorBody).not.toContain('useW_load_rx_');
    expect(methodBody).not.toContain('useW_load_rx_');
    // Still translated, through the plain (non-hook) runtime.
    expect(constructorBody).toContain('_w_load_()');
    expect(component).toContain('useW_load_rx_');
  });
});
