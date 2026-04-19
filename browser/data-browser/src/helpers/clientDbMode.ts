import { isRunningInTauri } from './tauri';

const LOCAL_STORAGE_KEY = 'atomic-disable-client-db';

/**
 * Whether the WASM ClientDb / OPFS offline layer should be initialized.
 *
 * Disabled when:
 * - Running under Tauri (embedded local server already fast enough; OPFS is
 *   redundant duplication).
 * - The user explicitly opted out via `disableClientDb()` (persisted in
 *   localStorage). Useful for debugging live-query behaviour against the
 *   server without the local cache masking issues.
 *
 * Any change requires a page reload to take effect — the ClientDb worker
 * is spawned at app boot.
 */
export function isClientDbEnabled(): boolean {
  if (isRunningInTauri()) return false;
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(LOCAL_STORAGE_KEY) !== '1';
}

export function setClientDbEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  if (enabled) {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  } else {
    localStorage.setItem(LOCAL_STORAGE_KEY, '1');
  }
}
