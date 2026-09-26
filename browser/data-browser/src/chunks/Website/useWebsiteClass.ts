import { useEffect, useState } from 'react';
import { core, useStore, type Store } from '@tomic/react';

/**
 * Look for the class among the resource's own declared classes, retried,
 * because a failure to ask and a genuine absence used to arrive as the same
 * `undefined`.
 *
 * `store.getResource` rejects on a cancelled request and after its own 10s
 * settle timeout, which a loaded machine reaches. The rejection used to be
 * swallowed, so one unlucky read decided the resource is not a website, and
 * nothing re-asked: the class resource itself never changes, so the
 * subscription below never fires either. The page then renders a website as a
 * bare list of its properties, with no error anywhere, until a reload.
 * `useDriveClass` in `chunks/PluginRuns/runScript.ts` carries the same
 * treatment for a drive's app and plugin classes, for the same reason.
 *
 * Outside the hook so the React compiler does not have to reason about a
 * try/catch inside a component.
 */
async function resolveWebsiteClass(
  store: Store,
  classes: string[],
  shortname: string,
  isCancelled: () => boolean,
): Promise<{ ok: true; value: string | undefined } | { ok: false }> {
  const attempts = 3;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let failed: unknown;

    for (const id of classes) {
      try {
        const resource = await store.getResource(id);

        if (isCancelled()) return { ok: false };

        if (resource.error) {
          failed = resource.error;
          continue;
        }

        if (resource.get(core.properties.shortname) === shortname) {
          return { ok: true, value: id };
        }
      } catch (error) {
        if (isCancelled()) return { ok: false };

        failed = error;
      }
    }

    // Every class was read and none of them is the one being looked for. That
    // is a real answer; most resources are not websites.
    if (failed === undefined) return { ok: true, value: undefined };

    if (attempt === attempts) {
      // `debug` rather than `error`: a page that renders the wrong thing
      // perfectly is the worst failure to diagnose, so this has to leave a
      // trace, but the e2e diagnostics collector polices every warning and
      // error with no allowlist, and the identical `console.error` in
      // `useDriveClass` is an open red there.
      console.debug(
        `[website] could not resolve "${shortname}" among ${classes.join(
          ', ',
        )}; showing the resource as an ordinary one`,
        failed,
      );

      return { ok: false };
    }

    await new Promise(resolve => setTimeout(resolve, 150 * attempt));
  }

  return { ok: false };
}

/** Inspect the resource's declared classes, not every term in the drive ontology. */
export function useWebsiteClass(
  classKey: string,
  shortname = 'website-project',
) {
  const store = useStore();
  const [resolved, setResolved] = useState<{ key: string; subject?: string }>();
  useEffect(() => {
    let active = true;
    const classes = classKey.split('|').filter(Boolean);

    const resolve = async () => {
      const result = await resolveWebsiteClass(
        store,
        classes,
        shortname,
        () => !active,
      );

      if (!active) return;

      // A failed lookup leaves whatever was already resolved in place. It is
      // not evidence that the class is gone, and dropping it turns a working
      // page into a generic one.
      if (!result.ok) return;

      setResolved(previous => {
        // A class's shortname does not change. So a later read of the same
        // classes that no longer sees it read something momentarily
        // incomplete, and is not news. Dropping the answer would render a
        // different component at `WebsitePage`'s position, which unmounts it
        // and loses its state, inline editing included; `ResourcePage`
        // already guards its loading branch for that reason.
        if (previous?.key === classKey && previous.subject && !result.value) {
          return previous;
        }

        return { key: classKey, subject: result.value };
      });
    };

    const unsubscribes = classes.map(id =>
      store.subscribe(id, () => {
        void resolve().catch(() => undefined);
      }),
    );
    void resolve().catch(() => undefined);

    return () => {
      active = false;
      unsubscribes.forEach(unsubscribe => unsubscribe());
    };
  }, [store, classKey, shortname]);

  return resolved?.key === classKey ? resolved.subject : undefined;
}
