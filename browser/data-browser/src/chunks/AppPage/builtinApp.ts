import {
  core,
  findSchema,
  pluginSchema,
  subjectsReferToSameResource,
  type SchemaStore,
} from '@tomic/lib';
import { isSyncablePrincipalApp } from '@chunks/PluginRuns/syncablePrincipalApp';
import {
  isSyncableResourceInDrive,
  findSyncableLegacyAccounts,
  platformLocalId,
  syncablePlatformSchema,
} from '@chunks/PluginRuns/syncablePlatform';

/** Closed native registration: provider metadata never selects executable code. */
export type BuiltinApp = { kind: 'syncables'; table: string; principal?: true };

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
  if (!(await isSyncableResourceInDrive(store, drive, subject)))
    throw new Error('This built-in App is outside the selected drive');
  const binding =
    app.properties?.['app-data'] && resource.get(app.properties['app-data']);
  const legacyProperty = terms.properties?.['syncable-legacy-accounts'];
  const legacy = legacyProperty && resource.get(legacyProperty);
  if (typeof binding !== 'string')
    throw new Error('This built-in App has no saved source root');

  if (await isSyncablePrincipalApp(store, drive, resource))
    return { kind: 'syncables', table: subject, principal: true };
  if (
    resource.get(core.properties.localId) !==
    platformLocalId(proxyOrigin, platformId)
  )
    throw new Error('This built-in App has no matching integration identity');

  if (!subjectsReferToSameResource(binding, subject) || legacy !== undefined) {
    if (!(await findSyncableLegacyAccounts(store, drive, subject)))
      throw new Error(
        'This built-in App has no matching legacy Accounts table',
      );
  }

  // Legacy installations are provisioned only by an explicit Apps Add/Open.
  // Passive viewing resolves the native root and never reparents saved data.
  return { kind: 'syncables', table: subject };
}
