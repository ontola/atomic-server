import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CollectionBuilder,
  core,
  StoreEvents,
  useStore,
  type Resource,
} from '@tomic/react';
import { findSchema, pluginSchema } from '@tomic/lib';
import { useAppClass } from '@chunks/PluginRuns/useDriveClass';

export interface DriveApp {
  subject: string;
  name: string;
  /** The row classes this app can show. */
  renders: string[];
}

export interface DriveApps {
  apps: DriveApp[];
  /**
   * Ask again. Call it when a menu that lists the apps opens, so opening it
   * always reflects what the drive holds now.
   */
  refresh: () => void;
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
 * A resource whose state says nothing about what it is: a draft that has not
 * been saved, or a placeholder that is still loading or failed.
 */
const undecided = (resource: Resource) =>
  resource.new ||
  resource.subject.startsWith('_new:') ||
  resource.loading ||
  !!resource.error;

/**
 * The apps on this drive, so one can be chosen as a way of looking at a table.
 *
 * Three sources, each covering what the others miss:
 *
 * - a query for the drive's app class when the page mounts;
 * - every resource the store takes in afterwards — a local save, another tab's
 *   commit, a drive sync — checked against the app class as it lands;
 * - the same query again whenever `refresh` is called, which the menus that
 *   list apps do as they open.
 *
 * The third exists because the second only hears about resources the store
 * announces. A resource whose state changed without a notification — a sync
 * delta that could not apply and was repaired later, an echo folded into a
 * resource in place — is not announced, and was then missing from "+ Add view"
 * until a reload (#1846).
 *
 * Every answer is folded in as it arrives, and each resource is read from the
 * store at that moment, so a slow read cannot hold back the others, and an
 * older answer cannot overwrite a newer one: all of them read the same live
 * resource.
 *
 * Resolved in state rather than read during render: the app class is minted
 * per drive, so this waits on a lookup, and filling a cache re-renders
 * nothing.
 */
export function useDriveApps(drive: string | undefined): DriveApps {
  const store = useStore();
  const appClass = useAppClass(drive);
  const [apps, setApps] = useState<DriveApp[]>([]);
  const reload = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    const offs: (() => void)[] = [];

    const cleanup = () => {
      cancelled = true;
      reload.current = () => undefined;
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
    let rendersProperty: string | undefined;

    const fold = (subject: string, app: DriveApp | undefined) => {
      if (cancelled || sameApp(known.get(subject), app)) return;

      if (app) known.set(subject, app);
      else known.delete(subject);

      setApps([...known.values()]);
    };

    const read = (resource: Resource) => {
      if (undecided(resource)) return;

      fold(resource.subject, readDriveApp(resource, appClass, rendersProperty));
    };

    const load = async () => {
      // Looked up on every load: a drive can gain the property after mount.
      const schema = await findSchema(store, drive, pluginSchema());

      if (cancelled) return;

      if (schema.properties?.renders !== rendersProperty) {
        rendersProperty = schema.properties?.renders;

        // What was folded without it has no `renders`; read it again.
        for (const subject of known.keys()) {
          const resource = store.resources.get(subject);
          if (resource) read(resource);
        }
      }

      // A fresh collection each time: a cached page is exactly the stale
      // answer a refresh is asked to replace.
      const members = await new CollectionBuilder(store)
        .setProperty(core.properties.isA)
        .setValue(appClass)
        .setPageSize(100)
        .build()
        .getAllMembers();

      if (cancelled) return;

      // Apps this hook knows of that the query did not return: read them
      // again rather than trusting either side, so a removed class drops out
      // and one the index has not caught up with stays.
      for (const subject of known.keys()) {
        if (members.includes(subject)) continue;

        const resource = store.resources.get(subject);
        if (resource) read(resource);
      }

      // In parallel, and each folded as it resolves: `getResource` waits for a
      // resource that is still loading or being repaired, and one of those
      // must not keep every other app out of the menu.
      await Promise.all(
        members.map(subject =>
          store.getResource(subject).then(
            resource => {
              if (!cancelled) read(resource);
            },
            () => undefined,
          ),
        ),
      );
    };

    const run = () => void load().catch(() => undefined);

    offs.push(
      store.on(StoreEvents.ResourceUpdated, read),
      store.on(StoreEvents.ResourceRemoved, subject =>
        fold(subject, undefined),
      ),
    );

    reload.current = run;
    run();

    return cleanup;
  }, [store, drive, appClass]);

  const refresh = useCallback(() => reload.current(), []);

  return { apps, refresh };
}
