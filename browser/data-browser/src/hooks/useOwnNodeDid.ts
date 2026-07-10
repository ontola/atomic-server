import { useEffect, useState } from 'react';
import { getLocalServerOrigin, isRunningInTauri } from '../helpers/tauri';

const NODE_DID_PREFIX = 'did:ad:node:';

function isValidNodeDid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(NODE_DID_PREFIX) &&
    /^[0-9a-f]{64}$/i.test(value.slice(NODE_DID_PREFIX.length))
  );
}

/**
 * This device's own Iroh identity (`did:ad:node:<64 hex>`), or `undefined`
 * while it loads — or forever, in a plain browser tab.
 *
 * The app is only a peer node inside the Tauri shell, which embeds a server.
 * A browser tab talks to a remote server, so `/iroh-node-id` there names
 * *that server's* node, not this device: pairing UI must stay hidden.
 */
export function useOwnNodeDid(): string | undefined {
  const [nodeDid, setNodeDid] = useState<string>();

  useEffect(() => {
    if (!isRunningInTauri()) {
      return;
    }

    let cancelled = false;

    // Absolute origin: a bare path resolves against `tauri.localhost` (the
    // bundled assets), not the embedded server.
    fetch(`${getLocalServerOrigin()}/iroh-node-id`)
      .then(response => response.json())
      .then(data => {
        if (!cancelled && isValidNodeDid(data.nodeId)) {
          setNodeDid(data.nodeId);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return nodeDid;
}
