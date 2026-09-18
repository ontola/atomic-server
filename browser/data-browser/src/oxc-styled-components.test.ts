// @wc-ignore-file
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { transformSync as compileReact } from 'oxc-transform-react';

const srcDir = fileURLToPath(new URL('.', import.meta.url));

// Keep in sync with `styledComponentsOxcOptions` in oxcReactCompilerPlugin.ts.
const styledComponentsOxcOptions = {
  displayName: true,
  fileName: false,
} as const;

type RolldownTransform = (
  filename: string,
  code: string,
  options?: {
    jsx?: { runtime?: string };
    plugins?: { styledComponents?: typeof styledComponentsOxcOptions };
  },
) => { code: string; errors: unknown[] };

async function loadRolldownTransform(): Promise<RolldownTransform> {
  const require = createRequire(import.meta.url);
  const fromVite = createRequire(require.resolve('vite/package.json'));

  const utils = (await import(fromVite.resolve('rolldown/utils'))) as {
    transformSync: RolldownTransform;
  };

  return utils.transformSync;
}

function compileThenStyle(
  transform: RolldownTransform,
  filename: string,
  source: string,
) {
  const compiled = compileReact(filename, source, {
    jsx: { runtime: 'automatic' },
    reactCompiler: { target: '19' },
  });

  const styled = transform(filename, compiled.code, {
    jsx: { runtime: 'automatic' },
    plugins: { styledComponents: styledComponentsOxcOptions },
  });

  return { compiled, styled };
}

describe('oxc styled-components plugin', () => {
  it('adds displayName via Vite/Rolldown oxc, after the React Compiler pass', async () => {
    const transform = await loadRolldownTransform();
    const { compiled, styled } = compileThenStyle(
      transform,
      'Button.tsx',
      `
        import styled from 'styled-components';
        export const Button = styled.div\`
          color: blue;
          padding: 10px;
        \`;
        export function Comp({ name }: { name: string }) {
          return <Button>{name}</Button>;
        }
      `,
    );

    expect(compiled.fatal).toBe(false);
    expect(compiled.code).not.toContain('withConfig');
    expect(compiled.code).toContain('react/compiler-runtime');

    expect(styled.errors).toEqual([]);
    expect(styled.code).toContain('react/compiler-runtime');
    expect(styled.code).toMatch(
      /styled\.div\.withConfig\(\{\s*displayName:\s*"Button"/,
    );
    expect(styled.code).not.toMatch(/displayName:\s*"Button-Button"/);
  });

  it('minifies css`` helpers without wrapping them in withConfig', async () => {
    const transform = await loadRolldownTransform();
    const { styled } = compileThenStyle(
      transform,
      'helpers.ts',
      `
        import { css, keyframes } from 'styled-components';
        export const x = css\`
          color: red;
        \`;
        export const y = keyframes\`
          from { opacity: 0 }
          to { opacity: 1 }
        \`;
      `,
    );

    expect(styled.errors).toEqual([]);
    expect(styled.code).toContain('css`color:red;`');
    expect(styled.code).toMatch(/keyframes`from\{opacity:0\}to\{opacity:1\}`/);
    expect(styled.code).not.toContain('withConfig');
  });

  it('gives Button.tsx named styled components after both passes', async () => {
    const transform = await loadRolldownTransform();
    const file = join(srcDir, 'components/Button.tsx');
    const { compiled, styled } = compileThenStyle(
      transform,
      file,
      readFileSync(file, 'utf8'),
    );

    expect(compiled.fatal).toBe(false);
    expect(styled.errors).toEqual([]);
    expect(styled.code).toContain('displayName: "ButtonDefault"');
    expect(styled.code).toContain('displayName: "ButtonSubtle"');
    expect((styled.code.match(/withConfig/g) ?? []).length).toBeGreaterThan(5);
  });
});
