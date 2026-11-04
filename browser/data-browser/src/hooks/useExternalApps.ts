import {
  core,
  server,
  useCollection,
  useCollectionPage,
  useResources,
} from '@tomic/react';
import type { ExternalAppInfo } from '@helpers/driveApps';

/**
 * The `ExternalApp`s registered in a drive: an isA query scoped to the drive,
 * which the collection caches and keeps current as commits arrive. Empty while
 * loading.
 */
export function useExternalApps(drive: string | undefined): ExternalAppInfo[] {
  const { collection } = useCollection(
    {
      property: core.properties.isA,
      value: server.classes.externalApp,
      drive,
    },
    { pageSize: 100 },
  );
  const members = useCollectionPage(collection, 0);
  const resources = useResources(drive ? members : []);

  const apps: ExternalAppInfo[] = [];

  for (const [subject, resource] of resources) {
    if (resource.loading || resource.error) continue;

    const name = resource.get(core.properties.name);

    apps.push({
      subject,
      name: typeof name === 'string' ? name : subject,
      homepage: resource.get(server.properties.homepage),
      openUrlTemplate: resource.get(server.properties.openUrlTemplate),
      handlesClasses: resource.get(server.properties.handlesClasses) ?? [],
    });
  }

  return apps;
}
