import { isHostedDistribution } from './managedServer';
import { isRunningInTauri } from './tauri';

const LOCAL_STORAGE_KEY = 'atomic-disable-client-db';

/**
 * Whether the WASM ClientDb / OPFS offline layer should be initialized.
 *
 * The platform default: on under the web (it IS the local database there),
 * off under a self-built Tauri app (the embedded local server already persists
 * everything; OPFS would be redundant duplication). On in the hosted desktop
 * build: once signed in, the store talks to the account's server, which
 * refuses drives it does not host, so a new drive can only live on this device
 * in the client database. An explicit user/feature choice
 * (persisted in localStorage) overrides the default in either direction —
 * local-only drives need this on Tauri, since they never reach a server and
 * their queries can only be answered by the ClientDb.
 *
 * Any change requires a page reload to take effect — the ClientDb worker
 * is spawned at app boot.
 */
export function isClientDbEnabled(): boolean {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);

    if (stored === '1') return false;
    if (stored === '0') return true;
  }

  return !isRunningInTauri() || isHostedDistribution();
}

export function setClientDbEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;

  // '0' = explicitly enabled, '1' = explicitly disabled — both override the
  // platform default (the key name predates the three-state semantics).
  localStorage.setItem(LOCAL_STORAGE_KEY, enabled ? '0' : '1');
}
