// @vitest-environment jsdom
// @wc-ignore-file
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { styled, ThemeProvider, type DefaultTheme } from 'styled-components';
import { transformSync } from 'oxc-transform-react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { resourceTheme } from '@tomic/resource-ui/theme';
import { defaultUITheme } from '@tomic/ui/theme';
import type { DerivedColumnSpec } from '@tomic/table-page/TablePage/derivedColumns';
import type { TableColumn } from '@tomic/table-page/TablePage/useTableColumns';

afterEach(cleanup);

it('recomputes a compiled derived cell when the formula engine loads after a stable row', () => {
  // Vitest normally skips compiling app components. Execute the actual source
  // with production memoization so an ignored readiness signal cannot pass.
  const filename = resolve(
    process.cwd(),
    '../table-page/src/TablePage/useDerivedColumns.tsx',
  );
  const compiled = transformSync(filename, readFileSync(filename, 'utf8'), {
    jsx: { runtime: 'automatic' },
    reactCompiler: { target: '19' },
  });
  expect(compiled.fatal).toBe(false);
  expect(compiled.errors.filter(error => error.severity === 'Error')).toEqual(
    [],
  );
  expect(compiled.code).toContain('react/compiler-runtime');

  let engineReady = false;
  const listeners = new Set<() => void>();
  const row = {
    get: () => '2026-11-19',
    stable: { on: () => () => {} },
  };
  const store = { subscribe: () => () => {} };
  const spec: DerivedColumnSpec = {
    id: 'thirsty-for',
    label: 'Thirsty for',
    formula: 'days(now() - last_watered)',
    vars: { last_watered: 'last-watered' },
    valueKind: 'days',
  };
  const computeDerived = vi.fn(() => (engineReady ? 0 : undefined));
  const imports = {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    'react/compiler-runtime': createRequire(filename)('react/compiler-runtime'),
    'styled-components': { styled },
    '@tomic/react': {
      ResourceEvents: { LocalChange: 'change' },
      useResource: () => row,
      useStore: () => store,
    },
    '@tomic/resource-ui/theme': { resourceTheme },
    './derivedColumns.js': {
      DEFAULT_DERIVED_WIDTH: 120,
      computeDerived,
      formatDerivedValue: (_spec: DerivedColumnSpec, value: number) =>
        value === 0 ? 'today' : String(value),
      isLive: () => false,
      specProperties: (value: DerivedColumnSpec) => Object.values(value.vars),
    },
    './formulaEngine.js': {
      useFormulaReady: () =>
        React.useSyncExternalStore(
          listener => {
            listeners.add(listener);

            return () => {
              listeners.delete(listener);
            };
          },
          () => engineReady,
        ),
    },
  };
  const executable = compiled.code
    .replace(
      /import \{([^}]+)\} from "([^"]+)";/g,
      (_statement, names: string, source: string) =>
        `const {${names.replace(/\bas\b/g, ':')}} = imports[${JSON.stringify(source)}];`,
    )
    .replace('export function useDerivedColumns', 'function useDerivedColumns');
  const useColumns = new Function(
    'imports',
    `${executable}; return useDerivedColumns;`,
  )(imports) as (specs: DerivedColumnSpec[]) => TableColumn[];

  function Grid() {
    const [column] = useColumns([spec]);
    const Cell = column.virtual!.Cell;

    return <Cell subject='plant-row' rowIndex={0} columnIndex={0} />;
  }

  render(
    <ThemeProvider theme={defaultUITheme as unknown as DefaultTheme}>
      <Grid />
    </ThemeProvider>,
  );
  expect(screen.getByTestId('derived-thirsty-for').textContent).toBe('');

  // Only engine readiness changes: the row, stored date and spec stay fixed.
  act(() => {
    engineReady = true;
    listeners.forEach(listener => listener());
  });
  expect(screen.getByTestId('derived-thirsty-for').textContent).toBe('today');
});
