import { useLayoutEffect } from 'react';
import type { LoroDoc } from 'loro-crdt';
import { type Resource, useStore } from '@tomic/react';
import { isAIReviewHeld } from '@chunks/AI/aiReviewPersistHold';

/**
 * Live `LORO_SYNC` of a resource's Loro doc — incremental ops, no TipTap
 * cursors. Documents use {@link useLoroSync} which adds ephemeral presence
 * on top of this.
 *
 * `doc` may be undefined until Loro WASM is loaded; the effects no-op then.
 */
export function useLoroDocSync(
  resource: Resource,
  doc: LoroDoc | undefined,
): void {
  const store = useStore();
  const subject = resource.subject;

  useLayoutEffect(() => {
    if (!doc) {
      return;
    }

    const unsub = doc.subscribeLocalUpdates(bytes => {
      if (isAIReviewHeld(store, subject)) return;

      store.broadcastLoroSyncUpdate(subject, bytes);
      resource.markDirty();
    });

    return () => {
      unsub();
    };
  }, [doc, subject, store, resource]);

  useLayoutEffect(() => {
    if (!doc) {
      return;
    }

    return store.subscribeLoroSync(subject, (update: Uint8Array) => {
      resource.importLoroUpdate(update);
    });
  }, [doc, subject, store, resource]);
}

/**
 * Live `LORO_SYNC` of many resources (AI chat messages + their parts).
 * Subjects that are not yet in the store, or whose Loro doc is not
 * loaded, are skipped until the next render.
 */
export function useLoroSyncForest(subjects: string[]): void {
  const store = useStore();
  const key = subjects.join('\0');

  useLayoutEffect(() => {
    const unsubs: Array<() => void> = [];

    for (const subject of subjects) {
      const resource = store.resources.get(subject);

      if (!resource) {
        continue;
      }

      const doc = resource.getLoroDoc();

      if (!doc) {
        continue;
      }

      unsubs.push(
        doc.subscribeLocalUpdates(bytes => {
          if (isAIReviewHeld(store, subject)) return;

          store.broadcastLoroSyncUpdate(subject, bytes);
          resource.markDirty();
        }),
      );

      unsubs.push(
        store.subscribeLoroSync(subject, (update: Uint8Array) => {
          resource.importLoroUpdate(update);
        }),
      );
    }

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
    };
    // `key` is the subjects list; store is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, store]);
}
