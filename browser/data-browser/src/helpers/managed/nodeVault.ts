// @wc-ignore-file
// Cloud Vault against this device's embedded node, for the desktop and Android
// apps.
//
// In a browser the vault runs inside the WASM ClientDb, because that *is* the
// local database there. These apps have no ClientDb: the embedded server
// already persists everything, and running an OPFS copy alongside would mean
// two databases holding the same drive. So the same `atomic_lib::vault`
// functions run natively against the node's own store, and this file is only
// the shape that lets `backupDrive` / `restoreDrive` call them without knowing
// which one they got.
//
// Only sealing lives on the other side of this. The network half — presigned
// URLs, uploads, the agent-signed proof — stays in `vault.ts`, where the
// agent's key already is. See `desktop/src/lib.rs`.
import { decodeB64, encodeB64 } from '@tomic/lib';
import { invoke } from '@tauri-apps/api/core';
import type { RestoreOutcome, VaultCapableDb } from './vault';

/**
 * Bytes cross the IPC boundary base64-encoded rather than as arrays.
 *
 * A `Uint8Array` does not survive the trip as itself — it arrives as a plain
 * number array, and `serde` on the other side takes it as one. That is
 * precisely how a stringified byte array once ended up stored in every vault
 * object, uploaded and confirmed, unreadable. A string has one obvious
 * meaning on both sides.
 */
type SealedObject = { objectKey: string; sealed: string };

export const nodeVault: VaultCapableDb = {
  async vaultExport(
    driveSubject,
    key,
    keyEpoch,
    drivePseudonym,
    devicePubkey,
    segment,
  ) {
    const result = await invoke<
      | (Omit<SealedObject, 'objectKey'> & {
          objectKey: string;
          resources: number;
          tombstones: number;
        })
      | null
    >('vault_export', {
      driveSubject,
      key: encodeB64(key),
      keyEpoch,
      drivePseudonym,
      devicePubkey,
      segment,
    });

    // Null is a real answer, not a failure: the drive has not changed since the
    // last segment, so there is nothing to upload.
    if (!result) return null;

    return {
      objectKey: result.objectKey,
      sealed: decodeB64(result.sealed),
      resources: result.resources,
      tombstones: result.tombstones,
    };
  },

  async vaultImport(key, keyEpoch, drivePseudonym, objects): Promise<RestoreOutcome> {
    return invoke<RestoreOutcome>('vault_import', {
      key: encodeB64(key),
      keyEpoch,
      drivePseudonym,
      // Order matters and is the caller's: a later segment's deletion has to be
      // applied after the earlier pack that created the resource.
      objects: objects.map(
        (o): SealedObject => ({
          objectKey: o.objectKey,
          sealed: encodeB64(o.sealed),
        }),
      ),
    });
  },

  async vaultCommitSegment(drivePseudonym, devicePubkey, segment) {
    await invoke('vault_commit_segment', {
      drivePseudonym,
      devicePubkey,
      segment,
    });
  },
};
