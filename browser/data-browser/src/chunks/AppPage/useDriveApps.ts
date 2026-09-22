import { useEffect, useState } from 'react';
import { CollectionBuilder, core, dataBrowser, useStore } from '@tomic/react';
import { findSchema, pluginSchema } from '@tomic/lib';

export interface DriveApp {
  subject: string;
  name: string;
  /** The row classes this app can show. */
  renders: string[];
}

/**
 * The apps that can show rows of `rowClass`.
 *
 * An app declares what it handles, and is offered nowhere else. Listing every
 * app on every table would mean a calendar app offered for a table of
 * invoices — and with fifty apps on a drive, a menu nobody can read.
 *
 * Pure, so the rule can be read and tested without a store.
 */
export function appsForClass(
  apps: DriveApp[],
  rowClass: string | undefined,
): DriveApp[] {
  if (!rowClass) return [];

  return apps.filter(app => app.renders.includes(rowClass));
}

/**
 * The apps on this drive, so one can be chosen as a way of looking at a table.
 *
 * Resolved in state because the drive schema provides the property that names
 * the row classes an app can render.
 */
export function useDriveApps(drive: string | undefined): DriveApp[] {
  const store = useStore();
  const [apps, setApps] = useState<DriveApp[]>([]);

  useEffect(() => {
    let cancelled = false;

    if (!drive) {
      // Cleared asynchronously so this effect never sets state during the
      // render that scheduled it, which would cascade.
      queueMicrotask(() => {
        if (!cancelled) setApps([]);
      });

      return () => {
        cancelled = true;
      };
    }

    (async () => {
      const collection = new CollectionBuilder(store)
        .setProperty(core.properties.isA)
        .setValue(dataBrowser.classes.view)
        .setPageSize(100)
        .build();

      const schema = await findSchema(store, drive, pluginSchema());
      const rendersProperty = schema.properties?.renders;
      const found: DriveApp[] = [];

      for (const subject of await collection.getAllMembers()) {
        const resource = await store.getResource(subject);
        if (resource.get(dataBrowser.properties.viewKind) !== 'code') continue;
        const renders = rendersProperty
          ? resource.get(rendersProperty)
          : undefined;

        found.push({
          subject,
          name: resource.title,
          renders: Array.isArray(renders)
            ? renders.filter((c): c is string => typeof c === 'string')
            : [],
        });
      }

      if (!cancelled) setApps(found);
    })().catch(() => {
      if (!cancelled) setApps([]);
    });

    return () => {
      cancelled = true;
    };
  }, [store, drive]);

  return apps;
}
