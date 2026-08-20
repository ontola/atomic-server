import { useEffect, useRef } from 'react';
import { useStore } from '@tomic/react';
import { useSettings } from './AppSettings';
import { resolveDidForOpen } from './didResolve';

/**
 * When a show URL carries `agent` / `node` share hints, try to materialize the
 * subject (pkarr → dial → known peers) once per subject+hints combo.
 */
export function DidResolveOnShow({
  subject,
  agent,
  node,
}: {
  subject: string;
  agent?: string;
  node?: string;
}): null {
  const store = useStore();
  const { drive } = useSettings();
  const attempted = useRef<string>('');

  useEffect(() => {
    if (!subject.startsWith('did:ad:')) {
      return;
    }

    // Nothing to resolve without a hint — ErrorPage offers known peers.
    if (!agent && !node) {
      return;
    }

    const key = `${subject}|${agent ?? ''}|${node ?? ''}`;

    if (attempted.current === key) {
      return;
    }

    attempted.current = key;

    void resolveDidForOpen(subject, {
      drive,
      agent,
      node,
      tryPeers: !node && !agent,
      isAvailable: async sub => {
        try {
          const resource = await store.getResource(sub);

          return !resource.error;
        } catch {
          return false;
        }
      },
    }).then(result => {
      if (result.ok && result.via !== 'local') {
        store.fetchResourceFromServer(subject, { setLoading: true });
      }
    });
  }, [subject, agent, node, drive, store]);

  return null;
}
