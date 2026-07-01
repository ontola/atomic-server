import type { Agent } from '@tomic/react';

/**
 * Node info. Every Atomic node exposes `GET /node-info` with read-only
 * metadata; a managed node (one reporting to a control plane) sets `managed`
 * and a `dashboardUrl` so the welcome screen can adapt its copy and route
 * account creation to the dashboard.
 */
export type ManagedInfo = {
  managed: boolean;
  /** User-facing cloud dashboard URL, when the node is managed. */
  dashboardUrl: string | null;
};

const DEFAULT: ManagedInfo = { managed: false, dashboardUrl: null };

export async function fetchManagedInfo(serverUrl: string): Promise<ManagedInfo> {
  if (!serverUrl) return DEFAULT;

  try {
    const res = await fetch(new URL('/node-info', serverUrl).toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return DEFAULT;

    const data = await res.json();

    const rawDashboardUrl =
      typeof data?.dashboardUrl === 'string' ? data.dashboardUrl : null;

    // In local dev the user-facing portal runs on localhost, but a managed node
    // reports its public dashboard URL (typically a tunnel that isn't reachable
    // locally). Point account/plan management at the local portal instead.
    const onLocalhost =
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1');

    return {
      managed: Boolean(data?.managed),
      dashboardUrl:
        rawDashboardUrl && onLocalhost
          ? 'http://localhost:49237'
          : rawDashboardUrl,
    };
  } catch {
    // Older/self-hosted nodes have no such endpoint — treat as non-managed.
    return DEFAULT;
  }
}

/**
 * Where the welcome screen's "Create account" should go, given a node's
 * {@link ManagedInfo}:
 *  - a managed node with a dashboard URL → the cloud portal (which handles
 *    sign-up + email verification);
 *  - anything else (self-hosted / FOSS, or managed-but-no-URL) → the local
 *    DID-agent creation flow. This is what keeps the FOSS UX intact.
 *
 * Pure on purpose, so the FOSS-vs-managed branch is unit-tested without a
 * server or the portal. The full cross-system journey is covered in atomic-saas.
 */
export type AccountCreationTarget =
  | { kind: 'portal'; url: string }
  | { kind: 'local' };

export function accountCreationTarget(info: ManagedInfo): AccountCreationTarget {
  if (info.managed && info.dashboardUrl) {
    return { kind: 'portal', url: info.dashboardUrl };
  }

  return { kind: 'local' };
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
    const timestamp = Date.now();
    const res = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'x-atomic-public-key': await agent.getPublicKey(),
        'x-atomic-signature': await agent.createSignature(
          driveSubject,
          timestamp,
        ),
        'x-atomic-timestamp': timestamp.toString(),
        'x-atomic-agent': agent.subject,
      },
    });

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
