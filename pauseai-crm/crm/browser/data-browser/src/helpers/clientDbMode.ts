import { isRunningInTauri } from './tauri';

const LOCAL_STORAGE_KEY = 'atomic-disable-client-db';

/**
 * Whether the WASM ClientDb / OPFS offline layer should be initialized.
 *
 * The platform default: on under the web (it IS the local database there),
 * off under Tauri (the embedded local server already persists everything;
 * OPFS would be redundant duplication). An explicit user/feature choice
 * (persisted in localStorage) overrides the default in either direction —
 * the demo needs this on Tauri, since its local-only drives never reach a
 * server and their queries can only be answered by the ClientDb.
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

  return !isRunningInTauri();
}

export function setClientDbEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;

  // '0' = explicitly enabled, '1' = explicitly disabled — both override the
  // platform default (the key name predates the three-state semantics).
  localStorage.setItem(LOCAL_STORAGE_KEY, enabled ? '0' : '1');
}
