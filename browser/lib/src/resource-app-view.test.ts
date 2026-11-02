import { dataBrowser } from './ontologies/dataBrowser.js';
import { expect, it } from 'vitest';
import { createApp } from './plugin-app.js';
import {
  resolveResourceAppView,
  resolveDefaultResourceAppView,
} from './resource-app-view.js';
import { fakeSchemaStore } from './test-schema-store.js';
import { core } from './ontologies/core.js';

it('resolves a hidden installation within its drive without changing resources', async () => {
  const { store, resources } = fakeSchemaStore();
  resources.get('drive-ontology')![core.properties.parent] = 'drive';
  const view = await createApp(store, {
    drive: 'drive',
    name: 'Keep View',
    source: 'export function view(){}',
    dataKind: 'none',
    installationHidden: true,
  });
  const before = JSON.stringify([...resources]);
  expect(await resolveResourceAppView(store, 'drive', view.app)).toBe(view.app);
  expect(JSON.stringify([...resources])).toBe(before);
});

it('refuses ordinary content, foreign installations and parent cycles as renderers', async () => {
  const { store, resources } = fakeSchemaStore();
  const view = await createApp(store, {
    drive: 'drive',
    name: 'View',
    source: 'export function view(){}',
    dataKind: 'none',
  });
  expect(
    await resolveResourceAppView(store, 'drive', 'ordinary-note'),
  ).toBeUndefined();
  resources.get(view.app)![core.properties.parent] = 'another-drive';
  expect(
    await resolveResourceAppView(store, 'drive', view.app),
  ).toBeUndefined();
  resources.get(view.app)![core.properties.parent] = view.app;
  expect(
    await resolveResourceAppView(store, 'drive', view.app),
  ).toBeUndefined();
});

it('uses one compatible view-only renderer on notes and folders before the sync app is reopened', async () => {
  const { store, resources } = fakeSchemaStore();
  const view = await createApp(store, {
    drive: 'drive',
    name: 'Keep View',
    source: 'export function view(){}',
    dataKind: 'none',
  });
  const sync = await createApp(store, {
    drive: 'drive',
    name: 'Keep sync',
    source: 'export function view(){}',
  });
  resources.set('note', { [core.properties.isA]: ['note-class'] });
  resources.set('folder', {
    [core.properties.isA]: [dataBrowser.classes.folder],
    [core.properties.classtype]: 'note-class',
  });
  resources.set('table', {
    [core.properties.isA]: [dataBrowser.classes.table],
    [core.properties.classtype]: 'note-class',
  });
  const candidates = [
    { subject: sync.app, resourceRenders: ['note-class'] },
    { subject: view.app, resourceRenders: ['note-class'] },
  ];
  expect(
    await resolveDefaultResourceAppView(store, 'drive', 'note', candidates),
  ).toBe(view.app);
  expect(
    await resolveDefaultResourceAppView(store, 'drive', 'folder', candidates),
  ).toBe(view.app);
  expect(
    await resolveDefaultResourceAppView(store, 'drive', 'table', candidates),
  ).toBeUndefined();
  const other = await createApp(store, {
    drive: 'drive',
    name: 'Another view',
    source: 'export function view(){}',
    dataKind: 'none',
  });
  expect(
    await resolveDefaultResourceAppView(store, 'drive', 'note', [
      ...candidates,
      { subject: other.app, resourceRenders: ['note-class'] },
    ]),
  ).toBeUndefined();
});

it('never treats table-only compatibility as permission to replace resource pages', async () => {
  const { store, resources } = fakeSchemaStore();
  const view = await createApp(store, {
    drive: 'drive',
    name: 'Keep View',
    source: 'export function view(){}',
    dataKind: 'none',
  });
  resources.set('item', { [core.properties.isA]: ['keep-item-class'] });
  resources.set('imported-item', {
    [core.properties.isA]: ['imported-checklist-class'],
  });
  const tableOnly = {
    subject: view.app,
    renders: ['keep-item-class', 'imported-checklist-class'],
  };
  expect(
    await resolveDefaultResourceAppView(store, 'drive', 'item', [tableOnly]),
  ).toBeUndefined();
  expect(
    await resolveDefaultResourceAppView(store, 'drive', 'imported-item', [
      tableOnly,
    ]),
  ).toBeUndefined();
});
