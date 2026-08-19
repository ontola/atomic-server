import type { Plugin } from 'vite';
import { transform } from 'oxc-transform-react';

// Same skip-filter @vitejs/plugin-react uses for the Babel compiler preset:
// files with neither a capitalized name nor a `use*` identifier are not
// worth running the compiler on. JSX/TS stripping still runs for every
// matched file so Fast Refresh instrumentation stays in this pass.
const looksLikeReactCode = /\b[A-Z]|\buse/;

const includeRE = /\.[cm]?[jt]sx?(?:$|\?)/;
const excludeRE = /\/node_modules\//;

/**
 * Native React Compiler via `oxc-transform-react`, mirroring the unreleased
 * `@vitejs/plugin-react` `compiler: true` integration
 * (vitejs/vite-plugin-react#1419, shipping in 6.1.0).
 *
 * oxc-transform-react owns compiler + TS + JSX + Fast Refresh in one pass.
 * Rolldown's built-in JSX refresh must stay off or it double-instruments.
 *
 * Once plugin-react 6.1.0 is on npm this file can be deleted in favour of
 * `react({ compiler: true })`. Babel stays for styled-components displayName.
 */
export function oxcReactCompiler(): Plugin[] {
  let sourcemap = true;
  let jsxDevelopment = false;
  let fastRefresh = false;

  const compilerPlugin: Plugin = {
    name: 'atomic:oxc-react-compiler',
    enforce: 'pre',
    config() {
      return {
        optimizeDeps: {
          include: ['react/compiler-runtime'],
        },
      };
    },
    configResolved(config) {
      sourcemap = config.command !== 'build' || !!config.build.sourcemap;
      jsxDevelopment = !config.isProduction;
      fastRefresh =
        !config.isProduction &&
        config.command === 'serve' &&
        config.server.hmr !== false;
    },
    transform: {
      filter: {
        id: {
          include: includeRE,
          exclude: excludeRE,
        },
      },
      async handler(code, id) {
        const isClient = this.environment?.config.consumer !== 'server';
        const shouldCompile = isClient && looksLikeReactCode.test(code);
        const filename = id.split('?')[0]!;

        const result = await transform(filename, code, {
          jsx: {
            runtime: 'automatic',
            development: jsxDevelopment,
            refresh: isClient && fastRefresh,
          },
          reactCompiler: shouldCompile ? { target: '19' } : false,
          sourcemap,
        });

        const diagnostics = result.errors.map(
          error =>
            `${error.message}${error.codeframe ? `\n${error.codeframe}` : ''}`,
        );

        if (result.fatal) {
          this.error(
            diagnostics.join('\n\n') || 'React Compiler transform failed.',
          );
        }

        for (const diagnostic of diagnostics) {
          this.warn(diagnostic);
        }

        return { code: result.code, map: result.map };
      },
    },
  };

  // plugin-react 6.0.x always turns Rolldown JSX refresh on in serve mode.
  // A post-enforce config hook wins that merge so only oxc-transform-react
  // emits `$RefreshReg$` / `$RefreshSig$`.
  const disableOxcRefresh: Plugin = {
    name: 'atomic:oxc-react-compiler-disable-oxc-refresh',
    enforce: 'post',
    config() {
      return {
        oxc: {
          jsx: {
            refresh: false,
          },
        },
      };
    },
  };

  return [compilerPlugin, disableOxcRefresh];
}
