// @wc-ignore-file
import {
  core,
  dataBrowser,
  ensureSchema,
  type Store,
  type Resource,
} from '@tomic/react';
import {
  platformSchema,
  termKey,
  type FetchedPlatform,
} from '../../../../../integrations/localthought/schema';
import type { Config } from '../../../../../integrations/localthought/plugin';
import {
  localSchemaStore,
  ensureLocalInstallationResource as ensureInstallationResource,
} from './installationResources';
import { platformName } from './localThought';
import {
  localThoughtExtension,
  schemaNamespace,
} from './localThoughtExtension';

export async function ensureImportTables(
  store: Store,
  drive: string,
  resource: Resource,
  identity: string,
  fetched: FetchedPlatform,
  extensionId?: 'calendar' | 'none',
  schemaPlatform?: string,
): Promise<Config> {
  const { platform } = fetched;
  const namespace = schemaPlatform ?? schemaNamespace(platform, extensionId);
  const extension = localThoughtExtension(platform, extensionId);
  const schemaStore = localSchemaStore(store);
  const name = platformName(platform);
  const schema = await ensureSchema(
    schemaStore,
    drive,
    platformSchema(namespace, fetched.ontology.terms),
  );
  const destinations: Config['destinations'] = {};
  const properties: Record<string, string> = {};
  for (const term of fetched.ontology.terms.filter(t => t.kind === 'property'))
    properties[term.shortname] = schema.properties[termKey(namespace, term)];
  const classes = fetched.ontology.terms.filter(t => t.kind === 'class');

  for (const term of classes) {
    const rowClass = schema.classes[termKey(namespace, term)];
    const tableName =
      classes.length === 1 ? name : `${name}: ${term.shortname}`;
    const destination = await ensureInstallationResource(store, drive, {
      parent: resource.subject,
      localId: `${identity}:table:${term.shortname}`,
      isA: [dataBrowser.classes.table],
      propVals: {
        [core.properties.name]: tableName,
        [core.properties.classtype]: rowClass,
      },
    });
    const columns = [
      core.properties.name,
      ...[...term.requires, ...term.recommends]
        .map(path => fetched.ontology.terms.find(t => t.path === path))
        .filter(t => t !== undefined)
        .map(t => properties[t.shortname]),
    ];
    const view = await ensureInstallationResource(store, drive, {
      parent: destination.subject,
      localId: `${identity}:view:${term.shortname}`,
      isA: [dataBrowser.classes.view],
      propVals: {
        [core.properties.name]: tableName,
        [dataBrowser.properties.viewKind]: 'table',
        [dataBrowser.properties.viewColumns]: columns,
      },
    });
    const calendar =
      extension?.view.classShortname === term.shortname
        ? await ensureInstallationResource(store, drive, {
            parent: destination.subject,
            localId: `${identity}:calendar:${term.shortname}`,
            isA: [dataBrowser.classes.view],
            propVals: {
              [core.properties.name]: tableName,
              [dataBrowser.properties.viewKind]: 'calendar',
              [dataBrowser.properties.viewGroupBy]:
                properties[extension.view.groupByShortname],
              [dataBrowser.properties.viewColumns]: columns,
            },
          })
        : undefined;
    const existingViews = destination.get(dataBrowser.properties.tableViews) as
      | string[]
      | undefined;
    await destination.set(dataBrowser.properties.tableViews, [
      ...new Set([
        ...(existingViews ?? []),
        view.subject,
        ...(calendar ? [calendar.subject] : []),
      ]),
    ]);
    const currentDefault = destination.get(
      dataBrowser.properties.tableDefaultView,
    );

    if (
      !currentDefault ||
      (calendar &&
        !existingViews?.includes(calendar.subject) &&
        currentDefault === view.subject)
    ) {
      await destination.set(
        dataBrowser.properties.tableDefaultView,
        calendar?.subject ?? view.subject,
      );
    }

    await destination.save();
    destinations[term.shortname] = { table: destination.subject, rowClass };
  }

  return { platform, destinations, properties };
}
