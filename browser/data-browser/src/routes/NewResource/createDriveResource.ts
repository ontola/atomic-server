import { core, createApp, dataBrowser, type Store } from '@tomic/lib';
import { createPlugin } from '@chunks/PluginRuns/runScript';
import { createWebsite, starterWebsite } from '@chunks/Website/websiteModel';
import { handOverAppKey } from '@chunks/AppPage/appAgent';
import { STARTER_APP_SOURCE } from '@chunks/AppPage/starter';
import type { DriveCreation } from './creationCatalog';

export type AppMode = 'blocks' | 'site' | 'code';

/** Creates the complete starter, including any drive-local schema it needs. */
export async function createDriveResource(
  kind: DriveCreation,
  store: Store,
  drive: string,
  parent: string,
  mode: AppMode = 'blocks',
): Promise<string> {
  switch (kind) {
    case 'plugin-script':
      return createPlugin(store, { parent, drive });

    case 'app': {
      if (mode === 'blocks') {
        const app = await store.newResource({
          parent,
          isA: dataBrowser.classes.view,
          propVals: {
            [core.properties.name]: 'New app',
            [dataBrowser.properties.viewKind]: 'blocks',
          },
        });
        await app.save();
        return app.subject;
      }

      if (mode === 'site') {
        const resource = await store.getResource(parent);
        const document = resource.hasClasses(dataBrowser.classes.documentV2)
          ? parent
          : undefined;
        const website = await createWebsite(
          store,
          drive,
          starterWebsite(document ? resource.title : 'New app', document),
          parent,
        );

        return website.subject;
      }

      const created = await createApp(store, {
        drive,
        parent,
        name: 'New app',
        emoji: '🧩',
        source: STARTER_APP_SOURCE,
      });

      // The app remains usable if handing its identity to the node fails.
      try {
        await handOverAppKey(store, {
          drive,
          app: created.app,
          secret: created.secret,
        });
      } catch (error) {
        store.notifyError(error);
      }

      return created.app;
    }
  }
}
