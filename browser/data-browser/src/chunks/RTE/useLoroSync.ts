import { useEffect, useLayoutEffect, useMemo } from 'react';
import type { LoroDoc } from 'loro-crdt';
import { CursorEphemeralStore } from 'loro-prosemirror';
import { type Resource, useStore } from '@tomic/react';

/**
 * Sets up Loro document and ephemeral (cursor/presence) sync over WebSocket.
 * Returns a CursorEphemeralStore for cursor sharing.
 */
export function useLoroSync(
  resource: Resource,
  doc: LoroDoc,
): CursorEphemeralStore {
  const store = useStore();
  const subject = resource.subject;

  const ephemeralStore = useMemo(() => {
    // 30 second TTL for presence data
    return new CursorEphemeralStore(doc.peerIdStr, 30000);
  }, [doc]);

  // Subscribe to local doc updates, broadcast them, and mark resource dirty.
  //
  // The callback receives the bytes for just the new local ops — use them
  // directly instead of re-exporting the entire doc history each time. The
  // earlier version called `doc.export({ mode: 'update' })` here, which
  // exports every op from the start of the doc's life and grows linearly
  // with the session: in a long collaborative edit, each keystroke would
  // broadcast hundreds of KB and the remote tab would visibly lag behind
  // cursor updates while it imported the bulk replay.
  //
  // Earlier comment worried that a peer missing init ops would get the
  // delta stuck "pending". That's actually fine — Loro queues ops with
  // unmet dependencies and applies them when the deps arrive, and the
  // cold-open path is already covered by the `SYNC_VV` handshake in
  // `WSClient.startVVSync` (full snapshot exchange on WS connect).
  useLayoutEffect(() => {
    const unsub = doc.subscribeLocalUpdates(bytes => {
      store.broadcastLoroSyncUpdate(subject, bytes);
      // Mark the resource as dirty so save() knows there are local changes
      resource.markDirty();
    });

    return () => {
      unsub();
    };
  }, [doc, subject, store, resource]);

  // Subscribe to remote doc updates
  useLayoutEffect(() => {
    const unsub = store.subscribeLoroSync(subject, (update: Uint8Array) => {
      doc.import(update);
    });

    return unsub;
  }, [doc, subject, store]);

  // Subscribe to local ephemeral updates and broadcast
  useEffect(() => {
    const unsub = ephemeralStore.subscribeLocalUpdates((data: Uint8Array) => {
      store.broadcastLoroEphemeralUpdate(subject, data);
    });

    return () => {
      unsub();
    };
  }, [ephemeralStore, subject, store]);

  // Subscribe to remote ephemeral updates
  useEffect(() => {
    const unsub = store.subscribeLoroEphemeral(
      subject,
      (update: Uint8Array) => {
        ephemeralStore.apply(update);
      },
    );

    return unsub;
  }, [ephemeralStore, subject, store]);

  return ephemeralStore;
}
