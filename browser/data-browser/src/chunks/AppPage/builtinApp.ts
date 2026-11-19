import {
  core,
  dataBrowser,
  findSchema,
  pluginSchema,
  subjectsReferToSameResource,
  type SchemaStore,
} from '@tomic/lib';
import {
  isSyncableResourceInDrive,
  loadSyncableResource,
  platformLocalId,
  syncablePlatformSchema,
} from '@chunks/PluginRuns/syncablePlatform';

/** Closed native registration: provider metadata never selects executable code. */
export type BuiltinApp = { kind: 'syncables'; table: string };

/** Read saved installation data without provisioning, OAuth or provider reads. */
export async function resolveBuiltinApp(
  store: SchemaStore,
  drive: string,
  subject: string,
): Promise<BuiltinApp | undefined> {
  const terms = await findSchema(store, drive, syncablePlatformSchema());
  const marker = terms.properties?.['builtin-app'];
  if (!marker) return undefined;
  const resource = await store.getResource(subject);
  if (resource.get(marker) !== 'syncables') return undefined;
  const app = await findSchema(store, drive, pluginSchema());
  const classes = resource.get(core.properties.isA);
  if (
    !app.classes?.app ||
    !Array.isArray(classes) ||
    !classes.includes(app.classes.app)
  )
    throw new Error('This built-in installation is not an App');
  const platform = terms.properties?.['syncable-platform-id'];
  const proxy = terms.properties?.['syncable-proxy-origin'];
  const platformId = platform && resource.get(platform);
  const proxyOrigin = proxy && resource.get(proxy);
  if (
    !platform ||
    !proxy ||
    typeof platformId !== 'string' ||
    typeof proxyOrigin !== 'string'
  )
    throw new Error('This built-in app has no integration source');
  platformLocalId(proxyOrigin, platformId);
  const tableSubject =
    app.properties?.['app-data'] && resource.get(app.properties['app-data']);
  const table =
    typeof tableSubject === 'string'
      ? await loadSyncableResource(store, tableSubject)
      : undefined;
  const tableClasses = table?.get(core.properties.isA);
  const parent = table?.get(core.properties.parent);
  if (
    !table ||
    !Array.isArray(tableClasses) ||
    !tableClasses.includes(dataBrowser.classes.table) ||
    typeof parent !== 'string' ||
    !subjectsReferToSameResource(parent, subject) ||
    table.get(platform) !== platformId ||
    table.get(proxy) !== proxyOrigin ||
    !(await isSyncableResourceInDrive(store, drive, subject)) ||
    !(await isSyncableResourceInDrive(store, drive, table.subject))
  )
    throw new Error(
      'This built-in app has no matching Accounts table in this drive',
    );

  return { kind: 'syncables', table: table.subject };
}
