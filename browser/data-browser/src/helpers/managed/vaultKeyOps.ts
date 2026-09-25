import { wasmBinaryUrl, wasmJsUrl } from '../wasmUrls';
import type { VaultKeyOps } from './vault';

/**
 * The vault's key operations, loaded from the wasm bundle on the main thread.
 *
 * Separate from the ClientDb worker on purpose: these are stateless crypto
 * calls, not database work, so they need neither OPFS nor the worker's
 * leader-election machinery. `recovery.ts` loads the same bundle the same way
 * for Argon2id.
 *
 * Sealing and importing stay in the worker — those touch the store, and the
 * store has exactly one writer.
 */
type VaultWasmModule = {
  default: (init?: { module_or_path: string }) => Promise<unknown>;
  vaultGenerateKey: () => Uint8Array;
  vaultProofMessage: () => Uint8Array;
  vaultWrapKey: (driveKey: Uint8Array, agentSecret: Uint8Array) => string;
  vaultUnwrapKey: (envelope: string, agentSecret: Uint8Array) => Uint8Array;
};

let modulePromise: Promise<VaultWasmModule> | null = null;

async function loadVaultWasm(): Promise<VaultWasmModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      // Versioned like every other load of this pair (see `wasmUrls.ts`):
      // sign-in now waits on this, and an unversioned url can be served an
      // older build's cached glue or binary.
      const wasmModule = (await import(
        /* @vite-ignore */ wasmJsUrl()
      )) as VaultWasmModule;
      await wasmModule.default({ module_or_path: wasmBinaryUrl() });

      return wasmModule;
    })().catch(error => {
      // A failed fetch must not stick for the page's lifetime: the next
      // sign-in retries it.
      modulePromise = null;
      throw error;
    });
  }

  return modulePromise;
}

/**
 * Key ops backed by the real wasm bundle.
 *
 * The functions are synchronous once loaded, so this resolves the module first
 * and closes over it — `useVaultBackup` calls these inside event handlers,
 * where an await per call would be noise.
 */
export async function loadVaultKeyOps(): Promise<
  VaultKeyOps & { proofMessage: Uint8Array }
> {
  const wasm = await loadVaultWasm();

  return {
    proofMessage: wasm.vaultProofMessage(),
    vaultGenerateKey: () => wasm.vaultGenerateKey(),
    vaultWrapKey: (driveKey, agentSecret) =>
      wasm.vaultWrapKey(driveKey, agentSecret),
    vaultUnwrapKey: (envelope, agentSecret) =>
      wasm.vaultUnwrapKey(envelope, agentSecret),
  };
}
