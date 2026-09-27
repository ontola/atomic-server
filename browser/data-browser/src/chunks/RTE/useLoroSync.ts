import { useEffect, useLayoutEffect, useMemo } from 'react';
import type { LoroDoc } from 'loro-crdt';
import { CursorEphemeralStore } from 'loro-prosemirror';
import { type Resource, useStore } from '@tomic/react';
import { isAIReviewHeld } from '../AI/aiReviewPersistHold';

/** How long a peer's cursor survives on the other tabs without a refresh. The
 *  `CursorEphemeralStore` below is constructed with it. */
const CURSOR_TTL_MS = 30_000;
/** Re-send the local cursor well inside that window, so it neither expires
 *  while the tab is alive nor depends on the one frame a caret move emits.
 *  `DrivePresenceManager` (lib/src/presence.ts) keeps drive presence alive the
 *  same way, with the same two numbers. */
const CURSOR_HEARTBEAT_MS = 10_000;

/**
 * Re-set and re-send the local peer's cursor entry, bumping its LWW timestamp.
 * Returns false when there is nothing to announce yet.
 *
 * The encoded entry goes on the wire directly rather than through
 * `subscribeLocalUpdates`: a `set` with a value-identical payload need not emit
 * a local update, which is the whole point here, since a caret that has not
 * moved is exactly the case this refreshes. `DrivePresenceManager.rebroadcast`
 * sends its own bytes for the same reason.
 */
export function rebroadcastLocalCursor(
  ephemeralStore: Pick<CursorEphemeralStore, 'get' | 'set' | 'encode'>,
  peer: string,
  send: (data: Uint8Array) => void,
): boolean {
  const state = ephemeralStore.get(peer);

  if (state === undefined || state === null) return false;

  ephemeralStore.set(peer, state);
  send(ephemeralStore.encode(peer));

  return true;
}

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
    return new CursorEphemeralStore(doc.peerIdStr, CURSOR_TTL_MS);
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
      if (isAIReviewHeld(store, subject)) return;
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

  // Keep the local cursor alive on the other tabs. A caret move emits exactly
  // one ephemeral frame, and nothing replays it: the frame is presence rather
  // than history, the server's fan-out drops frames under load on purpose
  // (`serve.rs`: "Presence is the first thing worth dropping"), a frame can be
  // dropped while the websocket is still authenticating, and the `apply` below
  // legitimately discards a cursor whose content has not arrived yet. Measured
  // over 80 runs of the two-tab test, the cursor frame reaches the other tab
  // BEFORE the document update it points into in every single one, 74 of 74
  // where both arrived, so that last case is the ordinary order rather than the
  // exception.
  //
  // So one lost frame used to mean no cursor until the collaborator moved their
  // caret again, and an idle collaborator's cursor expired after CURSOR_TTL_MS
  // while they were still there. `documents.spec.ts` "shows a collaborator's
  // ephemeral cursor position" failed 3 of about 52 four-worker rounds that way:
  // the typed character arrived and rendered, and only the cursor was missing.
  useEffect(() => {
    const timer = setInterval(() => {
      rebroadcastLocalCursor(ephemeralStore, doc.peerIdStr, data =>
        store.broadcastLoroEphemeralUpdate(subject, data),
      );
    }, CURSOR_HEARTBEAT_MS);

    return () => clearInterval(timer);
  }, [ephemeralStore, doc, subject, store]);

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
