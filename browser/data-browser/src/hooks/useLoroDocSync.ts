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
      doc.import(update);
    });
  }, [doc, subject, store]);
}
