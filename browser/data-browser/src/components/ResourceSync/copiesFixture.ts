// @wc-ignore-file
import type { Copy, PeerCopy, ResourceCopies } from '@tomic/react';

export type Part = {
  state: Copy['state'];
  confirmedAt?: number;
  error?: string;
};
export type PeerPart = Partial<PeerCopy> & { connectionId: string };

/** Build unified copies from the pieces a test cares about; every destination
 * defaults to unknown, with file contents not required.
 */
export type CopiesParts = {
  local?: Part;
  server?: Part & { url?: string };
  vault?: Part;
  peers?: {
    state?: ResourceCopies['peers']['state'];
    connectedCount?: number;
    confirmedCount?: number;
    peers?: PeerPart[];
  };
  contents?: {
    required?: boolean;
    local?: Part;
    server?: Part;
    vault?: Part;
    peers?: PeerPart[];
  };
};

export function copiesOf({
  local = { state: 'unknown' },
  server = { state: 'unknown' },
  vault = { state: 'unknown' },
  peers,
  contents,
}: CopiesParts = {}): ResourceCopies {
  const unknown: Part = { state: 'unknown' };

  return {
    required: contents?.required ?? false,
    local: { ...local, contents: contents?.local ?? unknown },
    server: { ...server, contents: contents?.server ?? unknown },
    vault: { ...vault, contents: contents?.vault ?? unknown },
    peers: {
      state: 'unknown',
      connectedCount: 0,
      confirmedCount: 0,
      ...peers,
      peers: (peers?.peers ?? []).map(peer => ({
        state: 'unknown',
        peerAgent: 'agent',
        ...peer,
        contents: {
          state: 'unknown',
          ...contents?.peers?.find(
            copy =>
              copy.connectionId === peer.connectionId &&
              copy.storageId === peer.storageId &&
              copy.generation === peer.generation,
          ),
        },
      })),
    },
  };
}
