import { isRunningInTauri } from './tauri';
import { isHostedDistribution } from './managedServer';
import { serverProps } from './serverOntology';

/**
 * Is the origin this app was served from an atomic-server?
 *
 * Usually yes: a node serves its own data-browser, and `window.location.origin`
 * is the server. The managed deployment breaks that: it serves the very same
 * SPA from a shared origin (`app.atomicserver.eu`) that is the portal's
 * process, not a node. Someone on the free tier has no node at all — their
 * workspace lives in this browser (OPFS) and in Cloud Vault — yet the store
 * still needs *some* `serverUrl`, and defaulting to the origin made the app
 * treat a static host as its server: a WebSocket retried forever with a toast
 * per attempt, `/server` polled for a JSON document that came back as
 * index.html, every commit parked in the outbox, and the Sync page insisting
 * the workspace "already lives on app.atomicserver.eu".
 *
 * So the hosted build asks once, at boot, before the Store exists. The answer
 * is kept here so later code can tell "no server" from "server offline"
 * without a second round trip.
 */

let originWithoutNode: string | undefined;

/** Origin (no trailing slash) as `new URL(...).origin` would give it. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * True when `url` points at the origin that was probed and found to run no
 * atomic-server. False for every other URL, including one never probed.
 */
export function isOriginWithoutNode(url: string | undefined): boolean {
  if (!url || !originWithoutNode) return false;

  return originOf(url) === originWithoutNode;
}

/** Only in tests. Boot sets this through {@link probeOriginForNode}. */
export function rememberOriginWithoutNode(origin: string | undefined): void {
  originWithoutNode = origin ? originOf(origin) : undefined;
}

/**
 * Whether this build should probe its own origin at all.
 *
 * Only the hosted distribution is ever served by a non-node — a source build
 * comes out of an atomic-server, so asking would only delay its boot. The
 * desktop shell has no HTTP origin to ask about (`tauri://localhost`).
 */
export function originMayLackNode(): boolean {
  return isHostedDistribution() && !isRunningInTauri();
}

/**
 * Ask `origin` whether it is an atomic-server, remembering a "no".
 *
 * A node answers `/server` with a JSON `Server` resource carrying its version
 * (see `fetchManagedInfo`); a static host serves the SPA's index.html for
 * that path, or a 404. Both are a definite no.
 *
 * Only a definite answer changes anything: a probe that fails outright
 * (offline, timeout) leaves the default in place, so a node-served install
 * reopened offline still tries to reconnect the way it always has.
 */
export async function probeOriginForNode(
  origin: string,
  timeoutMs = 3000,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(new URL('/server', origin).toString(), {
      headers: { Accept: 'application/ad+json' },
      signal: controller.signal,
    });

    if (res.status === 404) {
      rememberOriginWithoutNode(origin);

      return;
    }

    if (!res.ok) return;

    let data: unknown;

    try {
      data = await res.json();
    } catch {
      // index.html, not JSON.
      rememberOriginWithoutNode(origin);

      return;
    }

    const version = (data as Record<string, unknown> | null)?.[
      serverProps.version
    ];
    const nodeId = (data as Record<string, unknown> | null)?.[
      serverProps.nodeId
    ];

    if (!version && !nodeId) {
      rememberOriginWithoutNode(origin);
    }
  } catch {
    // No answer is not a "no".
  } finally {
    clearTimeout(timer);
  }
}
