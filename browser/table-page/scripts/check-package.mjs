/** Verify full-page declarations, canonical SDK field binding and Dutch catalogs outside the workspace. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const names = [
  'table-page',
  'resource-ui',
  'table',
  'ui',
  'react',
  'lib',
  'form-renderer',
];
if (process.argv.length !== names.length + 2)
  throw new Error(`Expected archives in this order: ${names.join(', ')}`);
const dependencies = Object.fromEntries(
  names.map((name, index) => [
    `@tomic/${name}`,
    `file:${resolve(process.argv[index + 2])}`,
  ]),
);
const consumer = mkdtempSync(join(tmpdir(), 'tomic-table-page-consumer-'));
const run = (command, args) =>
  execFileSync(command, args, { cwd: consumer, stdio: 'inherit' });

try {
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        ...dependencies,
        react: '19.2.6',
        'react-dom': '19.2.6',
        'styled-components': '6.4.2',
        'loro-crdt': '1.12.1',
        wuchale: '0.25.6',
      },
      devDependencies: {
        typescript: '6.0.3',
        jsdom: '30.1.0',
        '@types/react': '19.2.15',
        '@types/react-dom': '19.2.3',
      },
    }),
  );
  writeFileSync(
    join(consumer, 'pnpm-workspace.yaml'),
    `overrides: ${JSON.stringify({ ...dependencies, 'loro-crdt': '1.12.1', wuchale: '0.25.6' })}\n`,
  );
  run('pnpm', ['install', '--ignore-scripts']);
  writeFileSync(
    join(consumer, 'runtime.mjs'),
    `
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
const { Store, StoreContext, Datatype, LoroLoader } = await import('@tomic/react');
await LoroLoader.initializeLoro();
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'https://consumer.example/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
window.localStorage.setItem('atomic.locale', JSON.stringify('nl'));
const { createRoot } = await import('react-dom/client');
const { ThemeProvider } = await import('styled-components');
const { defaultUITheme } = await import('@tomic/ui');
const { InputString, LocaleProvider, ResourceUIHostProvider } = await import('@tomic/resource-ui');
const { FormValidationContextProvider } = await import('@tomic/resource-ui/components/forms/formValidation/FormValidationContextProvider');
const { TablePage, TableResource } = await import('@tomic/table-page');
assert.equal(typeof TablePage, 'function');
assert.equal(typeof TableResource, 'function');
const { registerLoaders, loadLocale } = await import('wuchale/load-utils');
let foreignRuntime;
registerLoaders('main', async () => ({ c: ['External host catalog'] }), 1, { get: () => foreignRuntime, set: (_id, runtime) => { foreignRuntime = runtime; } });
await loadLocale('en');
const originalForeignRuntime = foreignRuntime;

const store = new Store({ serverUrl: 'https://example.com', connect: false });
const resource = await store.newResource({ subject: '_new:consumer-record', noParent: true });
const property = { subject: '_new:consumer-name', datatype: Datatype.STRING, shortname: 'name', description: '' };
await resource.set(property.subject, 'Before', false);
const unavailable = () => { throw Error('Unexpected external integration in a record-field journey'); };
const host = {
 settings: { drive: '', contentLanguage: 'nl', setContentLanguage() {}, agent: undefined }, search: {},
 navigate: unavailable, navigateWithTransition: unavailable,
 links: { constructOpenURL: subject => subject, pathToURL: path => path },
 isRunningInTauri: () => false, reportError: unavailable, loadAtomicWasm: unavailable,
 DriveApps: ({ children }) => children({ apps: [], refresh() {} }), AppFrame: unavailable, WorkspaceControls: unavailable, ResourceCard: unavailable,
 errorFallback: unavailable,
};
const root = createRoot(document.getElementById('app'));
const field = React.createElement(InputString, { resource, property, commit: false, required: true, 'aria-label': 'Name' });
await act(async () => root.render(React.createElement(StoreContext.Provider, { value: store },
 React.createElement(ThemeProvider, { theme: defaultUITheme },
 React.createElement(ResourceUIHostProvider, { value: host },
 React.createElement(LocaleProvider, null,
 React.createElement(FormValidationContextProvider, { onValidationChange() {} }, field)))))));
for (let i = 0; i < 50 && !document.querySelector('input'); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
let input = document.querySelector('input');
assert.equal(input?.value, 'Before');
const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
await act(async () => { setInputValue.call(input, 'After'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
assert.equal(resource.get(property.subject), 'After', 'Public Resource/Property JSX must bind directly to the SDK resource');
await act(async () => { setInputValue.call(input, ''); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })); });
assert.equal(resource.get(property.subject), '');
assert.match(document.body.textContent, /Verplicht/, 'The packed resource field must use the Dutch Atomic catalog');
assert.doesNotMatch(document.body.textContent, /i18n-404|i18n-400/);
assert.equal(foreignRuntime, originalForeignRuntime, 'Loading Atomic Dutch must leave the host catalog unchanged');
const { default: Message } = await import('@tomic/resource-ui/locale-message');
const keyWarnings = [];
const originalError = console.error;
console.error = (...args) => { if (/Each child|unique.*key/.test(args.join(' '))) keyWarnings.push(args); else originalError(...args); };
try {
  await act(async () => root.render(React.createElement('button', null, React.createElement(Message, { x: [[0], ' Pakket'], t: [() => React.createElement('svg', { 'data-message-icon': '' })], a: [] }))));
  assert.ok(document.querySelector('[data-message-icon]'));
  assert.equal(keyWarnings.length, 0, 'The packed helper must retain Atomic’s keyed fragment patch');
} finally { console.error = originalError; }

await act(async () => root.unmount());
dom.window.close();
`,
  );
  run(process.execPath, ['runtime.mjs']);
  writeFileSync(
    join(consumer, 'consumer.tsx'),
    `
import { TablePage } from '@tomic/table-page';
import { InputString } from '@tomic/resource-ui';
import type { Resource, Property } from '@tomic/react';
declare const resource: Resource<never>;
declare const property: Property;
const page = <TablePage resource={resource} />;
const editor = <InputString resource={resource} property={property} />;
// @ts-expect-error A property is a bound SDK property, not an untyped field name.
const invalid = <InputString resource={resource} property="name" />;
void [page, editor, invalid];
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
  console.info(
    'Packed TablePage declarations, direct SDK field editing and Dutch validation passed.',
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
