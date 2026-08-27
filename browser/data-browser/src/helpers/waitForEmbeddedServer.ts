// @wc-ignore-file
// Keep the HTML splash up until this device's embedded atomic-server is
// actually accepting connections. The webview is ready first — often by
// seconds on a cold Android start, and on every `cargo tauri dev` rebuild —
// and creating the Store in that window used to fetch into a port nothing
// was listening on, then settle on "Could not reach the server".
//
// Two signals, because neither is enough on its own:
// - `node_status` (Tauri IPC) knows when *our* node failed (DB lock) and
//   when its HTTP port is accepting. Invoke is the only check that works
//   on an Android release build, where cleartext HTTP to localhost is off.
// - HTTP GET is the fallback for e2e tests that fake `__TAURI_INTERNALS__`
//   without a real invoke (see pairing-dialog.spec.ts). Those point at a
//   server that is already up, so the wait resolves on the first poll.

import { getLocalServerOrigin, isRunningInTauri } from './tauri';

export type NodeStatus = {
  ready: boolean;
  error?: string | null;
};

export type WaitForEmbeddedServerDeps = {
  isTauri?: () => boolean;
  origin?: string;
  fetchFn?: typeof fetch;
  getStatus?: () => Promise<NodeStatus | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  showError?: (message: string) => void;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 100;

const TIMEOUT_MESSAGE =
  'The local node did not start in time. Restart the app. If this keeps happening, another atomic-server may already be using this data directory.';

/** Write the failure onto the HTML splash so it is visible without React. */
export function showEmbeddedServerError(message: string): void {
  if (typeof document === 'undefined') {
    return;
  }

  const status = document.getElementById('loader-status');

  if (status) {
    status.hidden = false;
    status.textContent = message;
  }

  const loader = document.querySelector('.loader');
  loader?.classList.add('is-failed');
  loader?.setAttribute('aria-busy', 'false');
}

async function defaultGetStatus(): Promise<NodeStatus | undefined> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');

    return await invoke<NodeStatus>('node_status');
  } catch {
    // No invoke (e2e fake, or the runtime has not injected yet). HTTP below.
    return undefined;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function httpIsUp(
  origin: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);

  try {
    // Any HTTP response means the listener is up — 401/404 included.
    // Connection refused / abort / CORS-as-network-error: not yet.
    await fetchFn(origin, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });

    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves once the embedded node is accepting connections.
 * No-op in a regular browser. Throws after showing the error on the splash
 * if the node failed to start or the deadline passed — and does not resolve,
 * so `App.tsx` never creates a Store against a dead port.
 */
export async function waitForEmbeddedServer(
  deps: WaitForEmbeddedServerDeps = {},
): Promise<void> {
  const isTauri = deps.isTauri ?? isRunningInTauri;

  if (!isTauri()) {
    return;
  }

  const origin = deps.origin ?? getLocalServerOrigin();
  const fetchFn = deps.fetchFn ?? fetch;
  const getStatus = deps.getStatus ?? defaultGetStatus;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const showError = deps.showError ?? showEmbeddedServerError;

  const started = now();

  showStarting();

  while (now() - started < timeoutMs) {
    const status = await getStatus();

    if (status?.error) {
      showError(status.error);
      throw new Error(status.error);
    }

    if (status?.ready) {
      return;
    }

    if (await httpIsUp(origin, fetchFn)) {
      return;
    }

    await sleep(intervalMs);
  }

  showError(TIMEOUT_MESSAGE);
  throw new Error(TIMEOUT_MESSAGE);
}

function showStarting(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const status = document.getElementById('loader-status');

  if (!status || status.textContent) {
    return;
  }

  status.hidden = false;
  status.textContent = 'Starting…';
}
