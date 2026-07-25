import { signRequest, type Agent } from '@tomic/react';
import { serverProps, peerProps } from './serverOntology';

/** A device the server syncs with directly, from `/server`'s `peers`. */
export type ServerPeer = {
  nodeId: string;
  deviceName: string | null;
  /** Whether it holds a connection to the server right now. */
  live: boolean;
};

/**
 * Node info, read from `GET /server` — a plain Atomic `Server` resource
 * describing the node you are talking to. A managed node (one reporting to a
 * control plane) sets `managed` and a `portalUrl`, so the welcome screen can
 * adapt its copy and route account creation to the dashboard.
 *
 * Fetched rather than read through the store, because the node being asked
 * about is often *not* the store's active server: the desktop shell asks its
 * own embedded node, and the sync page asks servers it hasn't switched to yet.
 */
export type ManagedInfo = {
  managed: boolean;
  /** User-facing portal URL, when the node is managed. */
  portalUrl: string | null;
  /** This node's `did:ad:node:...` identity, if its p2p transport is running. */
  nodeId?: string | null;
  /** The atomic-server version the node runs. */
  version?: string | null;
  /** The devices this server syncs with — how a browser sees the phone that
   *  paired with its server, since a browser is not itself a node. */
  peers?: ServerPeer[];
};

/** What a node reports when it is unreachable, or says nothing about itself. */
export const EMPTY_NODE_INFO: ManagedInfo = {
  managed: false,
  portalUrl: null,
  nodeId: null,
  version: null,
  peers: [],
};

const DEFAULT = EMPTY_NODE_INFO;

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export async function fetchManagedInfo(
  serverUrl: string,
): Promise<ManagedInfo> {
  if (!serverUrl) return DEFAULT;

  try {
    const res = await fetch(new URL('/server', serverUrl).toString(), {
      headers: { Accept: 'application/ad+json' },
    });

    if (!res.ok) return DEFAULT;

    const data = await res.json();

    const rawPortalUrl = readString(data?.[serverProps.portalUrl]);

    // In local dev the user-facing portal runs on localhost, but a managed node
    // reports its public dashboard URL (typically a tunnel that isn't reachable
    // locally). Point account/plan management at the local portal instead.
    const onLocalhost =
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1');

    const rawPeers = data?.[serverProps.peers];
    const peers: ServerPeer[] = Array.isArray(rawPeers)
      ? rawPeers
          .map((p): ServerPeer | null => {
            const nodeId = readString(p?.[peerProps.nodeId]);

            return nodeId
              ? {
                  nodeId,
                  deviceName: readString(p?.[peerProps.deviceName]),
                  live: p?.[peerProps.live] === true,
                }
              : null;
          })
          .filter((p): p is ServerPeer => p !== null)
      : [];

    return {
      managed: Boolean(data?.[serverProps.managed]),
      portalUrl:
        rawPortalUrl && onLocalhost ? 'http://localhost:49237' : rawPortalUrl,
      nodeId: readString(data?.[serverProps.nodeId]),
      version: readString(data?.[serverProps.version]),
      peers,
    };
  } catch {
    // Older/self-hosted nodes have no such endpoint — treat as non-managed.
    return DEFAULT;
  }
}

/**
 * Whether `/server` actually answered like an atomic-server node. Every
 * current node reports its version there (the node id additionally requires
 * the p2p transport to be running); anything else living at an origin —
 * notably the managed deployment's shared app host, which serves this SPA but
 * is not a node — yields {@link EMPTY_NODE_INFO}. Used to keep non-nodes out
 * of the known-servers list on the /sync page.
 */
export function isAtomicServer(info: ManagedInfo): boolean {
  return Boolean(info.version || info.nodeId);
}

/**
 * Where the welcome screen's "Create account" should go, given a node's
 * {@link ManagedInfo}:
 *  - a managed node with a dashboard URL → the managed portal (which handles
 *    sign-up + email verification);
 *  - anything else (self-hosted / FOSS, or managed-but-no-URL) → the local
 *    DID-agent creation flow. This is what keeps the FOSS UX intact.
 *
 * Pure on purpose, so the FOSS-vs-managed branch is unit-tested without a
 * server or the portal. The full cross-system journey is covered in the managed service repo.
 */
export type AccountCreationTarget =
  | { kind: 'portal'; url: string }
  | { kind: 'local' };

export function accountCreationTarget(
  info: ManagedInfo,
): AccountCreationTarget {
  if (info.managed && info.portalUrl) {
    // `/signin`, not the portal root: the root is the landing page, so
    // someone who just clicked "Create account" would arrive at a sales
    // pitch and have to find the form. That path renders the bare
    // magic-link form directly. `new URL` so a portalUrl with or without a
    // trailing slash both resolve cleanly.
    try {
      return {
        kind: 'portal',
        url: new URL('/signin', info.portalUrl).toString(),
      };
    } catch {
      return { kind: 'portal', url: info.portalUrl };
    }
  }

  return { kind: 'local' };
}

/**
 * Ask a server to stop syncing with a paired device. A browser is not a node,
 * so this is how someone reading a server disconnects the phone that paired with
 * it. Signed with the agent (node-admin only, server-side) and best-effort:
 * returns false when the node is unreachable, the agent is unauthorized, or the
 * node predates the endpoint.
 */
export async function forgetServerPeer(
  serverUrl: string,
  nodeId: string,
  agent: Agent,
): Promise<boolean> {
  if (!serverUrl || !nodeId || !agent?.subject) return false;

  const url = new URL('/forget-peer', serverUrl);
  url.searchParams.set('node', nodeId);

  try {
    // Sign the exact URL being fetched (path + query), same scheme as
    // fetchNodeDriveUsage — the server rebuilds and verifies it.
    const headers = await signRequest(url.toString(), agent, {
      Accept: 'application/json',
    });
    const res = await fetch(url.toString(), { method: 'POST', headers });

    return res.ok;
  } catch {
    return false;
  }
}

export type NodeDriveUsage = {
  driveName: string | null;
  resourceCount: number;
  blobBytes: number;
  loroBytes: number;
};

/**
 * Per-drive usage (resource count + bytes) reported by the connected node's
 * `GET /drive-usage`. Generic — works on any atomic-server, self-hosted
 * included. The endpoint enforces read access, so the request is signed with
 * the agent (same scheme as @tomic/lib's `signRequest`). Returns null when the
 * node is unreachable, the agent is unauthorized, or the node predates the
 * endpoint.
 */
export async function fetchNodeDriveUsage(
  serverUrl: string,
  driveSubject: string,
  agent: Agent,
): Promise<NodeDriveUsage | null> {
  if (!serverUrl || !driveSubject || !agent?.subject) return null;

  const url = new URL('/drive-usage', serverUrl);
  url.searchParams.set('subject', driveSubject);

  try {
    // Sign the URL being fetched, not the drive. The server rebuilds the
    // signed message from the request it received — query string and all — so
    // signing anything else fails the auth check before routing, and the
    // endpoint answers 500 rather than the usage it holds.
    const headers = await signRequest(url.toString(), agent, {
      Accept: 'application/json',
    });
    const res = await fetch(url.toString(), { headers });

    if (!res.ok) return null;

    const data = await res.json();

    return {
      driveName: typeof data?.name === 'string' ? data.name : null,
      resourceCount: Number(data?.resourceCount ?? 0),
      blobBytes: Number(data?.blobBytes ?? 0),
      loroBytes: Number(data?.loroBytes ?? 0),
    };
  } catch {
    return null;
  }
}
