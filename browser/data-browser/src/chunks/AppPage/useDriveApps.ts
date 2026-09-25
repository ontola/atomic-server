import { useEffect, useState } from 'react';
import {
  CollectionBuilder,
  core,
  StoreEvents,
  useStore,
  type Resource,
} from '@tomic/react';
import { findSchema, pluginSchema } from '@tomic/lib';
import { useAppClass } from '@chunks/PluginRuns/runScript';

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
 * `resource` as a drive app, or `undefined` when it is not one (any more).
 *
 * Read from the resource itself, not from a query, so a change that arrives
 * by sync or from another tab counts the moment it lands — a `/query` answer
 * can lag the resource it describes.
 */
export function readDriveApp(
  resource: Resource,
  appClass: string,
  rendersProperty: string | undefined,
): DriveApp | undefined {
  const classes = resource.get(core.properties.isA);

  if (!Array.isArray(classes) || !classes.includes(appClass)) return undefined;

  const renders = rendersProperty ? resource.get(rendersProperty) : undefined;

  return {
    subject: resource.subject,
    name: resource.title,
    renders: Array.isArray(renders)
      ? renders.filter((c): c is string => typeof c === 'string')
      : [],
  };
}

const sameApp = (a: DriveApp | undefined, b: DriveApp | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.name === b.name &&
    a.renders.length === b.renders.length &&
    a.renders.every((c, i) => c === b.renders[i]));

/**
 * The apps on this drive, so one can be chosen as a way of looking at a table.
 *
 * Live: one query when the page mounts, then every resource the store takes in
 * — a local save, another tab's commit, a drive sync landing after navigation
 * — is checked against the app class and folded in. Reading only on mount left
 * an app installed a moment before opening a table missing from its menu until
 * a reload (#1846).
 *
 * Resolved in state rather than read during render: the app class is minted
 * per drive, so this waits on a lookup, and filling a cache re-renders
 * nothing.
 */
export function useDriveApps(drive: string | undefined): DriveApp[] {
  const store = useStore();
  const appClass = useAppClass(drive);
  const [apps, setApps] = useState<DriveApp[]>([]);

  useEffect(() => {
    let cancelled = false;
    const offs: (() => void)[] = [];

    const cleanup = () => {
      cancelled = true;
      offs.forEach(off => off());
    };

    if (!drive || !appClass) {
      // Cleared asynchronously so this effect never sets state during the
      // render that scheduled it, which would cascade.
      queueMicrotask(() => {
        if (!cancelled) setApps([]);
      });

      return cleanup;
    }

    const known = new Map<string, DriveApp>();
    // Subjects a live event has already decided. The mount query may have
    // been answered before that event, so it must not overrule it.
    const decided = new Set<string>();
    let queried = false;

    const publish = () => {
      if (!cancelled) setApps([...known.values()]);
    };

    const fold = (subject: string, app: DriveApp | undefined) => {
      decided.add(subject);

      if (sameApp(known.get(subject), app)) return;

      if (app) known.set(subject, app);
      else known.delete(subject);

      // Until the query answers, its own publish covers this.
      if (queried) publish();
    };

    (async () => {
      const schema = await findSchema(store, drive, pluginSchema());
      const rendersProperty = schema.properties?.renders;

      if (cancelled) return;

      // Subscribed before the query, so nothing that lands while it runs is
      // lost between the answer and the listener.
      offs.push(
        store.on(StoreEvents.ResourceUpdated, resource => {
          // An unsaved draft is not an app yet (its save notifies again), and
          // a placeholder that is still loading or failed says nothing about
          // what the resource is.
          if (resource.new || resource.subject.startsWith('_new:')) return;
          if (resource.loading || resource.error) return;

          fold(
            resource.subject,
            readDriveApp(resource, appClass, rendersProperty),
          );
        }),
        store.on(StoreEvents.ResourceRemoved, subject =>
          fold(subject, undefined),
        ),
      );

      const collection = new CollectionBuilder(store)
        .setProperty(core.properties.isA)
        .setValue(appClass)
        .setPageSize(100)
        .build();

      for (const subject of await collection.getAllMembers()) {
        if (cancelled) return;
        if (decided.has(subject)) continue;

        const resource = await store.getResource(subject);

        // `getResource` may itself have notified and decided it by now.
        if (decided.has(subject)) continue;

        const app = readDriveApp(resource, appClass, rendersProperty);

        if (app) known.set(subject, app);
      }

      queried = true;
      publish();
    })().catch(() => {
      // A failed query still leaves the live listener; show what it found.
      queried = true;
      publish();
    });

    return cleanup;
  }, [store, drive, appClass]);

  return apps;
}
