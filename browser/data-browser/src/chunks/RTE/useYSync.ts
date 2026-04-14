import { useStore, type Resource } from '@tomic/react';
import { useEffect } from 'react';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { AI_YJS_EDIT_ORIGIN } from './AIEditYOrigin';

type AwarenessUpdate = {
  added: number[];
  removed: number[];
  updated: number[];
};

export function useYSync(
  resource: Resource,
  property: string,
  doc: Y.Doc,
): awarenessProtocol.Awareness {
  const store = useStore();
  const awareness = new awarenessProtocol.Awareness(doc);

  useEffect(() => {
    const handleAwarenessUpdate = (
      { added, updated, removed }: AwarenessUpdate,
      origin: string,
    ) => {
      if (origin !== 'local') {
        // Only send local updates to the server.
        return;
      }

      const changedClients = [...updated, ...added, ...removed];

      const encodedUpdate = awarenessProtocol.encodeAwarenessUpdate(
        awareness,
        changedClients,
      );

      store.broadcastYSyncUpdate(resource.subject, property, {
        awarenessUpdate: encodedUpdate,
      });
    };

    awareness.on('update', handleAwarenessUpdate);

    const unsubYSync = store.subscribeYSync(
      resource.subject,
      property,
      ({ awarenessUpdate, docUpdate }) => {
        if (awarenessUpdate) {
          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            awarenessUpdate,
            'server',
          );
        }

        if (docUpdate) {
          Y.applyUpdateV2(doc, docUpdate);
        }
      },
    );

    return () => {
      awareness.off('update', handleAwarenessUpdate);
      unsubYSync();
    };
  }, [awareness, resource.subject, property, store, doc]);

  useEffect(() => {
    // AI preview edits use `applyPatchedJsonToYDocCollaborative`, which wraps the
    // Collaboration/y-sync dispatch in `yDoc.transact(..., AI_YJS_EDIT_ORIGIN)`.
    // Nested y-sync `transact` calls merge into that transaction, so `origin`
    // stays `AI_YJS_EDIT_ORIGIN` and we still skip broadcasting until the user confirms.
    const cb = doc.on('updateV2', (udpate, _origin, _doc, transaction) => {
      if (transaction.local && transaction.origin !== AI_YJS_EDIT_ORIGIN) {
        store.broadcastYSyncUpdate(resource.subject, property, {
          docUpdate: udpate,
        });
      }
    });

    return () => {
      doc.off('updateV2', cb);
    };
  }, [resource.subject, property, store, doc]);

  return awareness;
}
