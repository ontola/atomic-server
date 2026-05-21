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
): CursorEphemeralStore | undefined {
  const store = useStore();
  const subject = resource.subject;

  const ephemeralStore = useMemo(() => {
    // 30 second TTL for presence data
    return new CursorEphemeralStore(doc.peerIdStr, 30000);
  }, [doc]);

  // Subscribe to local doc updates, broadcast them, and mark resource dirty
  useLayoutEffect(() => {
    const unsub = doc.subscribeLocalUpdates(() => {
      // The callback update can be causally incomplete for peers that missed
      // early editor-initialisation ops. Send a self-contained update so remote
      // imports do not get stuck as pending.
      const update = doc.export({ mode: 'update' });
      store.broadcastLoroSyncUpdate(subject, update);
      // Mark the resource as dirty so save() knows there are local changes
      resource.markDirty();
    });

    return () => {
      unsub();
    };
  }, [doc, subject, store]);

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
