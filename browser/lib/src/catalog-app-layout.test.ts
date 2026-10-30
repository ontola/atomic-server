import { ensureSchema } from './plugin-schema.js';
import { pluginSchema } from './plugin-log.js';
import { expect, it } from 'vitest';
import { createApp, describeApp } from './plugin-app.js';
import {
  installCatalogApp,
  updateCatalogApp,
  migrateCatalogAppLayout,
  readInstalledCatalogApps,
  subresourceIntegrity,
  type CatalogApp,
} from './catalog-app.js';
import { fakeSchemaStore } from './test-schema-store.js';
import { core } from './ontologies/core.js';
import { dataBrowser } from './ontologies/dataBrowser.js';

const source = 'export function view() {}';

async function release(): Promise<CatalogApp> {
  return {
    id: 'google-keep',
    name: 'Google Keep',
    version: '0.2.0',
    module: 'https://plugins.test/keep.js',
    integrity: await subresourceIntegrity(source),
    dataKind: 'folder',
    installationHidden: true,
  };
}

it('migrates the existing dataset in place while preserving notes, baseline and signing identity', async () => {
  const { store, resources } = fakeSchemaStore();
  const created = await createApp(store, {
    drive: 'drive',
    name: 'Google Keep',
    source,
  });
  resources.set('note', {
    [core.properties.parent]: created.data,
    [core.properties.name]: 'Netto',
    baseline: 'unchanged',
    'provider-id': 'notes/1',
  });
  const note = { ...resources.get('note')! };
  const app = await release();
  const result = await updateCatalogApp(store, {
    drive: 'drive',
    subject: created.app,
    app,
    agent: created.agent,
    transport: async () => new Response(source),
  });
  expect(result.data).toBe(created.data);
  expect(result.rowClass).toBe(created.rowClass);
  expect(result.entrypoint).toBe(created.entrypoint);
  expect(resources.get('note')).toEqual(note);
  const data = resources.get(created.data)!;
  expect(data[core.properties.parent]).toBe('drive');
  expect(data[core.properties.isA]).toContain(dataBrowser.classes.folder);
  expect(data[core.properties.isA]).not.toContain(dataBrowser.classes.table);
  expect(data[core.properties.read]).toContain(created.agent);
  expect(data[core.properties.write]).toContain(created.agent);
  expect(resources.get(created.app)?.[core.properties.parent]).toBe(
    'drive-ontology',
  );
  const after = JSON.stringify([...resources]);
  await migrateCatalogAppLayout(store, {
    drive: 'drive',
    subject: created.app,
    app,
    agent: created.agent,
  });
  expect(JSON.stringify([...resources])).toBe(after);
});

it('does not move a dataset until the host has supplied its actual signing identity', async () => {
  const { store, resources } = fakeSchemaStore();
  const created = await createApp(store, {
    drive: 'drive',
    name: 'Google Keep',
    source,
  });
  await expect(
    migrateCatalogAppLayout(store, {
      drive: 'drive',
      subject: created.app,
      app: await release(),
    }),
  ).rejects.toThrow('identify this app');
  expect(resources.get(created.data)?.[core.properties.parent]).toBe(
    created.app,
  );
});

it('keeps a hidden view discoverable as an installed app without creating data', async () => {
  const { store, resources } = fakeSchemaStore();
  const app = {
    ...(await release()),
    id: 'google-keep-view',
    dataKind: 'none' as const,
  };
  const created = await installCatalogApp(store, {
    drive: 'drive',
    app,
    transport: async () => new Response(source),
  });
  expect((await describeApp(store, 'drive', created.app)).data).toBeUndefined();
  const installed = await readInstalledCatalogApps(
    store,
    'drive',
    async property =>
      [...resources]
        .filter(([, props]) => props[property] !== undefined)
        .map(([id]) => id),
  );
  expect(installed).toEqual([
    { subject: created.app, id: 'google-keep-view', version: '0.2.0' },
  ]);
});

it('refuses to grant a key access through an app-data pointer to unrelated content', async () => {
  const { store, resources } = fakeSchemaStore();
  const created = await createApp(store, {
    drive: 'drive',
    name: 'Google Keep',
    source,
  });
  resources.get(created.data)![core.properties.parent] = 'unrelated-folder';
  const before = JSON.stringify([...resources]);
  await expect(
    migrateCatalogAppLayout(store, {
      drive: 'drive',
      subject: created.app,
      app: await release(),
      agent: created.agent,
    }),
  ).rejects.toThrow('own dataset');
  expect(JSON.stringify([...resources])).toBe(before);
});

it('upgrades an existing app vocabulary and detaches old view data without deleting it', async () => {
  const { store, resources } = fakeSchemaStore();
  const created = await createApp(store, {
    drive: 'drive',
    name: 'Keep View',
    source,
  });
  const schema = await ensureSchema(store, 'drive', pluginSchema());
  const property = schema.properties['app-resource-view'];
  const appClass = resources.get(schema.classes.app)!;
  appClass[core.properties.recommends] = (
    appClass[core.properties.recommends] as string[]
  ).filter(id => id !== property);
  const ontology = resources.get('drive-ontology')!;
  ontology[core.properties.properties] = (
    ontology[core.properties.properties] as string[]
  ).filter(id => id !== property);
  const data = { ...resources.get(created.data)! };
  await updateCatalogApp(store, {
    drive: 'drive',
    subject: created.app,
    app: { ...(await release()), id: 'google-keep-view', dataKind: 'none' },
    transport: async () => new Response(source),
  });
  const updated = await ensureSchema(store, 'drive', pluginSchema());
  expect(
    resources.get(schema.classes.app)?.[core.properties.recommends],
  ).toContain(updated.properties['app-resource-view']);
  expect((await describeApp(store, 'drive', created.app)).data).toBeUndefined();
  expect(resources.get(created.data)).toEqual(data);
});
