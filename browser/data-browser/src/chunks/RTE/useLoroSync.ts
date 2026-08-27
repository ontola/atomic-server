import { useEffect, useMemo } from 'react';
import type { LoroDoc } from 'loro-crdt';
import { CursorEphemeralStore } from 'loro-prosemirror';
import { type Resource, useStore } from '@tomic/react';
import { useLoroDocSync } from '@hooks/useLoroDocSync';

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

  useLoroDocSync(resource, doc);

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
        try {
          ephemeralStore.apply(update);
        } catch (e) {
          // A cursor can arrive before the content it points into. Positions
          // reference Loro containers, and a peer editing a document this
          // device has not caught up on yet names containers the local doc
          // does not have — Loro throws "The container does not exist in the
          // doc". That became routine once presence started crossing peer
          // links: the update travels on its own channel and does not wait for
          // document state.
          //
          // Dropping it is correct. Presence is a snapshot of right now, so
          // there is nothing to replay — the next update after the document
          // catches up applies cleanly. Throwing here only produced an uncaught
          // error per keystroke of someone else's typing.
          console.debug('[presence] skipped a cursor for unsynced content:', e);
        }
      },
    );

    return unsub;
  }, [ephemeralStore, subject, store]);

  return ephemeralStore;
}
