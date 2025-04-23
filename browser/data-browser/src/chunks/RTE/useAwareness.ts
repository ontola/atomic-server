import { useStore, type Resource } from '@tomic/react';
import { useEffect } from 'react';
import * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';

type AwarenessUpdate = {
  added: number[];
  removed: number[];
  updated: number[];
};

export function useAwareness(
  resource: Resource,
  doc: Y.Doc,
): awarenessProtocol.Awareness {
  const store = useStore();
  const awareness = new awarenessProtocol.Awareness(doc);

  useEffect(() => {
    // store.subscribeAwareness(resource.subject);

    awareness.on(
      'update',
      ({ added, updated, removed }: AwarenessUpdate, origin: string) => {
        if (origin !== 'local') {
          // Only send local updates to the server.
          return;
        }

        const changedClients = [...updated, ...added, ...removed];

        const encodedUpdate = awarenessProtocol.encodeAwarenessUpdate(
          awareness,
          changedClients,
        );

        store.notifyAwarenessUpdate(resource.subject, encodedUpdate);
      },
    );

    return store.subscribeAwareness(resource.subject, update => {
      awarenessProtocol.applyAwarenessUpdate(awareness, update, 'server');
    });
  }, [awareness, resource.subject]);

  return awareness;
}
