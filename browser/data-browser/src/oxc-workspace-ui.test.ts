import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from 'vite';
import { oxcReactCompiler } from '../oxcReactCompilerPlugin';

const root = '/workspace/browser/data-browser';
const component =
  'export function Counter() { return <button>Counter</button>; }';

describe('workspace UI Fast Refresh', () => {
  it.each(['data-browser', 'ui', 'table', 'resource-ui', 'table-page'])(
    'registers UI components in %s',
    async owner => {
      const plugin = oxcReactCompiler()[0];
      const configure = plugin.configResolved as (
        config: ResolvedConfig,
      ) => void;
      configure({
        root,
        command: 'serve',
        isProduction: false,
        server: { hmr: true },
        build: {},
      } as ResolvedConfig);
      const transform = (
        plugin.transform as {
          handler: (
            this: unknown,
            source: string,
            filename: string,
          ) => Promise<{ code: string }>;
        }
      ).handler;
      const output = await transform.call(
        { environment: { config: { consumer: 'client' } } },
        component,
        `/workspace/browser/${owner}/src/Counter.tsx`,
      );
      expect(output.code).toContain('$RefreshReg$');
    },
  );
  it.each(['lib', 'react'])(
    'keeps SDK source %s outside refresh registration',
    async owner => {
      const plugin = oxcReactCompiler()[0];
      const configure = plugin.configResolved as (
        config: ResolvedConfig,
      ) => void;
      configure({
        root,
        command: 'serve',
        isProduction: false,
        server: { hmr: true },
        build: {},
      } as ResolvedConfig);
      const transform = (
        plugin.transform as {
          handler: (
            this: unknown,
            source: string,
            filename: string,
          ) => Promise<{ code: string }>;
        }
      ).handler;
      const output = await transform.call(
        { environment: { config: { consumer: 'client' } } },
        component,
        `/workspace/browser/${owner}/src/Counter.tsx`,
      );
      expect(output.code).not.toContain('$RefreshReg$');
    },
  );
});
