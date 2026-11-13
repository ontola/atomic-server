/** Verify built ESM and declarations without Data Browser source aliases. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const archive = resolve(process.argv[2]);
const consumer = mkdtempSync(join(tmpdir(), 'tomic-ui-consumer-'));
const run = (command, args) =>
  execFileSync(command, args, { cwd: consumer, stdio: 'inherit' });

try {
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@tomic/ui': `file:${archive}`,
        react: '19.2.6',
        'react-dom': '19.2.6',
        'styled-components': '6.4.2',
      },
      devDependencies: {
        typescript: '6.0.3',
        jsdom: '30.1.0',
        '@types/react': '19.2.15',
        '@types/react-dom': '19.2.3',
      },
    }),
  );
  run('pnpm', ['install', '--ignore-scripts']);
  writeFileSync(
    join(consumer, 'runtime.mjs'),
    `import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'styled-components';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const { Button, Spinner } = await import('@tomic/ui');
const { Checkbox } = await import('@tomic/ui/components/forms/Checkbox');
const { Dialog } = await import('@tomic/ui/components/Dialog/index');
const { DropdownMenu } = await import('@tomic/ui/components/Dropdown/index');
assert.equal(typeof Dialog, 'function');
assert.equal(typeof DropdownMenu, 'function');
const root = createRoot(document.getElementById('app'));
let changes = 0;
const theme = { colors: { text: '#123456', bg: '#fff', bg1: '#eee', bg2: '#ddd', main: '#234567' }, animation: { duration: '0s' }, radius: '8px', margin: 1 };
await act(async () => root.render(React.createElement(ThemeProvider, { theme },
  React.createElement(Button, { loading: 'Saving' }, 'Save'),
  React.createElement(Checkbox, { checked: false, onChange: () => changes++ }),
  React.createElement(Spinner, { centered: true }))));
assert.equal(document.querySelector('button').textContent, 'Saving');
assert.equal(document.querySelector('button').getAttribute('aria-busy'), 'true');
await act(async () => document.querySelector('input').click());
assert.equal(changes, 1);
assert.equal(document.querySelector('[role="status"]').getAttribute('aria-label'), 'Loading');
await act(async () => root.unmount());
dom.window.close();`,
  );
  run(process.execPath, ['runtime.mjs']);
  writeFileSync(
    join(consumer, 'consumer.tsx'),
    `import { Button, IconButton, Spinner, useResizable } from '@tomic/ui';
import { Dialog, useDialog } from '@tomic/ui/components/Dialog/index';
import { DropdownMenu, type DropdownMenuProps } from '@tomic/ui/components/Dropdown/index';
import { Checkbox } from '@tomic/ui/components/forms/Checkbox';
const controls = <><Button loading="Saving">Save</Button><IconButton title="Menu" /><Spinner /><Checkbox onChange={checked => { const value: boolean = checked; void value; }} /></>;
// @ts-expect-error The extracted declaration must retain checkbox's boolean callback.
const invalid = <Checkbox onChange={(value: string) => {}} />;
void [controls, invalid, useResizable, Dialog, useDialog, DropdownMenu];
const menu: DropdownMenuProps['items'] = [{ id: 'save', label: 'Save', onClick: () => {} }];
void menu;`,
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
    }),
  );
  run('pnpm', ['exec', 'tsc']);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
