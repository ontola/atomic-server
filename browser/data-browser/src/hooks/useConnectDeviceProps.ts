import { useEffect, useState, type ComponentProps } from 'react';
import { nodeId as parseNodeId, nodeSubject } from '@tomic/react';
import type { ConnectDevice } from '../components/ConnectDevice';
import { useSettings } from '../helpers/AppSettings';
import { fetchManagedInfo } from '../helpers/managedServer';
import { isOriginWithoutNode } from '../helpers/originNode';
import { serverLabel } from '../helpers/serverUrl';
import { isRunningInTauri } from '../helpers/tauri';
import { useOwnNodeDid } from './useOwnNodeDid';

/** `atomic:node:<hex>` or `did:ad:node:<hex>` to the form the code shows. */
function toNodeDid(id: string | null | undefined): string | null {
  const raw = id ? parseNodeId(id)?.split(':')[0] : undefined;

  return raw && /^[0-9a-f]{64}$/i.test(raw)
    ? nodeSubject(raw.toLowerCase())
    : null;
}

type Props = ComponentProps<typeof ConnectDevice>;

interface Overrides {
  /** The server's node id (raw hex). Pass it when the caller already reads
   * `/server`; leave it out and the hook reads it. */
  serverNodeId?: string | null;
  /** The caller's own gate on showing a browser tab's code. Default: the
   * server is a real node. */
  serverPairingAllowed?: boolean;
  serverUrl?: string;
}

/**
 * What `ConnectDevice` needs, so the Sync page and the Save dialog wire it the
 * same way. Inside the Tauri shell this app is itself a node and shows its own
 * code. A browser tab is not a node, so it shows the server's: the always-on
 * device another of yours should reach.
 */
export function useConnectDeviceProps({
  serverNodeId,
  serverPairingAllowed,
  serverUrl,
}: Overrides = {}): Props {
  const { setServer, baseURL } = useSettings();
  const isNode = isRunningInTauri();
  const url = serverUrl ?? baseURL;
  const ownNodeDid = useOwnNodeDid();
  const [fetchedDid, setFetchedDid] = useState<string | null>(null);
  const needsFetch = serverNodeId === undefined && !isNode;

  useEffect(() => {
    if (!needsFetch || !url) return;

    let cancelled = false;

    fetchManagedInfo(url)
      .then(info => !cancelled && setFetchedDid(toNodeDid(info.nodeId)))
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [needsFetch, url]);

  const serverDid = serverNodeId ? nodeSubject(serverNodeId) : fetchedDid;
  const pairNodeDid = isNode ? toNodeDid(ownNodeDid) : serverDid;

  return {
    pairNodeDid,
    showPairing:
      !!pairNodeDid &&
      (isNode || (serverPairingAllowed ?? !isOriginWithoutNode(url))),
    canTakeCode: isNode,
    serverName: serverLabel(url ?? ''),
    onAddServer: setServer,
  };
}
