/** Exercise package-manager, runtime and declaration resolution outside this monorepo. */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const archive = resolve(process.argv[2]);
const consumer = mkdtempSync(join(tmpdir(), 'tomic-table-consumer-'));
const run = (command, args) =>
  execFileSync(command, args, { cwd: consumer, stdio: 'inherit' });

try {
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@tomic/table': `file:${archive}`,
        react: '19.2.6',
        'react-dom': '19.2.6',
        'styled-components': '6.1.13',
      },
      devDependencies: {
        typescript: '6.0.3',
        jsdom: '30.1.0',
        '@emotion/is-prop-valid': '1.2.2',
        '@types/react': '19.2.15',
        '@types/react-dom': '19.2.3',
      },
    }),
  );
  run('pnpm', ['install', '--ignore-scripts']);
  writeFileSync(
    join(consumer, 'runtime.mjs'),
    `
    import assert from 'node:assert/strict';
    import React, { act } from 'react';
    import { createRoot } from 'react-dom/client';
    import { JSDOM } from 'jsdom';
    import { StyleSheetManager } from 'styled-components';
    import isPropValid from '@emotion/is-prop-valid';
    const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/' });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
    import { FancyTable, TableHostProvider, IntegerCell, parseInteger, CursorMode, ViewTab, ViewTabList, TableNavigationProvider, useTableNavigation, tableQueryIssues } from '@tomic/table';
    assert.equal(parseInteger('42'), 42);
    assert.equal(typeof IntegerCell.Edit, 'function');
    assert.notEqual(CursorMode.Edit, CursorMode.Visual);
    const grid = React.createElement(FancyTable, {
      columns: [], itemCount: 0, columnToKey: String, labelledBy: 'title',
      HeadingComponent: () => null, NewColumnButtonComponent: () => null,
      children: () => React.createElement('span'),
    });
    const root = createRoot(document.getElementById('app'));
    await act(async () => root.render(React.createElement(StyleSheetManager, { shouldForwardProp: (prop, target) => typeof target !== 'string' || isPropValid(prop) }, React.createElement(TableHostProvider, { value: {} }, grid, React.createElement(ViewTabList, {}, React.createElement(ViewTab, { name: 'All rows', active: true, onRename: () => {}, onEditingChange: () => {} }))))));
    assert.match(document.getElementById('app').innerHTML, /role="grid"/);
    assert.match(document.getElementById('app').innerHTML, /role="tab"/);
    assert.match(document.getElementById('app').textContent, /All rows/);
    assert.deepEqual(tableQueryIssues({ scope: { table: 'table:one', rowClass: 'class:row' }, filters: [{ property: 'quantity', operator: 'gt', value: '0' }], expressionFilters: [], pageSize: 30 }, { filterOperators: ['eq'], expressions: false, aggregates: false, grouping: false, sorting: true }), [{ feature: 'filter', index: 0, operator: 'gt' }]);
    const commands = [];
    function Location() {
      const { location, navigate } = useTableNavigation();
      return React.createElement('button', { onClick: () => navigate({ view: 'next' }, { replace: true }) }, location.view);
    }
    const navigation = { location: { view: 'first' }, navigate: (...args) => commands.push(args) };
    await act(async () => root.render(React.createElement(TableNavigationProvider, { value: navigation }, React.createElement(Location))));
    await act(async () => document.querySelector('button').click());
    assert.deepEqual(commands, [[{ view: 'next' }, { replace: true }]]);
    await act(async () => root.render(React.createElement(TableNavigationProvider, { value: { ...navigation, location: { view: 'back' } } }, React.createElement(Location))));
    assert.equal(document.querySelector('button').textContent, 'back');
    await act(async () => root.unmount());
    dom.window.close();
  `,
  );
  run(process.execPath, ['runtime.mjs']);
  writeFileSync(
    join(consumer, 'consumer.tsx'),
    `
    import { FancyTable, Cell, IntegerCell, ViewTab, ViewTabList, TableNavigationProvider, type TableNavigation, type TableQuery, type FancyTableProps } from '@tomic/table';
    const props: FancyTableProps<{ id: string }> = {
      columns: [{ id: 'name' }], itemCount: 1, columnToKey: column => column.id,
      labelledBy: 'title', HeadingComponent: ({ column }) => <span>{column.id}</span>,
      NewColumnButtonComponent: () => null,
      children: ({ index }) => <Cell rowIndex={index} columnIndex={1}>A value</Cell>,
    };
    const grid = <FancyTable {...props} />;
    const editor = <IntegerCell.Edit value={1} property="count" onChange={value => void value} />;
    // @ts-expect-error The public declarations must reject an invalid row count.
    const invalid: FancyTableProps<string>['itemCount'] = 'one';
    const views = <ViewTabList><ViewTab name="All rows" active onRename={name => void name} onEditingChange={editing => void editing} /></ViewTabList>;
    const navigation: TableNavigation = { location: { view: 'saved' }, navigate: (patch, options) => { void [patch, options]; } };
    const host = <TableNavigationProvider value={navigation}>{views}</TableNavigationProvider>;
    // @ts-expect-error Host resource routing is not part of the table patch.
    navigation.navigate({ subject: 'another-table' });
    const query: TableQuery = { scope: { table: 'table:one', rowClass: 'class:row' }, filters: [], expressionFilters: [], pageSize: 30 };
    // @ts-expect-error Filter operators must use the declared query vocabulary.
    query.filters.push({ property: 'quantity', value: '0', operator: 'arbitrary-code' });
    void [grid, editor, invalid, views, host, query];
  `,
  );
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        jsx: 'react-jsx',
        target: 'ES2022',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['consumer.tsx'],
    }),
  );
  run('pnpm', ['exec', 'tsc']);
  const manifest = JSON.parse(
    readFileSync(
      join(consumer, 'node_modules/@tomic/table/package.json'),
      'utf8',
    ),
  );
  if (
    Object.keys(manifest.dependencies ?? {}).some(name =>
      name.startsWith('@tomic/'),
    )
  )
    throw Error('Unexpected Atomic runtime dependency');
  console.info(
    'Packed table installed, rendered and typechecked in a clean external consumer.',
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
