import { useEffect, useState } from 'react';
import { getLocalServerOrigin, isRunningInTauri } from '../helpers/tauri';
import { fetchManagedInfo } from '../helpers/managedServer';
import { isValidNodeDid } from '../helpers/serverOntology';

/**
 * This device's own Iroh identity (`did:ad:node:<64 hex>`), or `undefined`
 * while it loads — or forever, in a plain browser tab.
 *
 * The app is only a peer node inside the Tauri shell, which embeds a server.
 * A browser tab talks to a remote server, so that server's `/server` resource
 * names *that server's* node, not this device: pairing UI must stay hidden.
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
    fetchManagedInfo(getLocalServerOrigin())
      .then(info => {
        if (!cancelled && isValidNodeDid(info.nodeId)) {
          setNodeDid(info.nodeId);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return nodeDid;
}
