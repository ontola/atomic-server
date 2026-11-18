import { canonicalizeScheme } from './subject.js';
import {
  parseSerializedServerReceipt,
  type SerializedServerReceipt,
} from './resource-sync-evidence.js';

/** Private local proof scope. Managed account IDs must never be displayed. */
export interface VaultSyncScope {
  managedAccount: string;
  agent: string;
  portalUrl: string;
  drive: string;
  drivePseudonym: string;
  keyEpoch: number;
}

export type SerializedVaultReceipt = SerializedServerReceipt;

export interface ResourceVaultEvidence {
  subject: string;
  snapshot: Uint8Array | null;
  vaultReceipt?: SerializedVaultReceipt;
}

export const parseSerializedVaultReceipt = parseSerializedServerReceipt;

export function normalizeVaultSyncScope(
  scope: VaultSyncScope,
): VaultSyncScope | undefined {
  try {
    const portal = new URL(scope.portalUrl);
    if (
      !['http:', 'https:'].includes(portal.protocol) ||
      [
        scope.managedAccount,
        scope.agent,
        scope.drive,
        scope.drivePseudonym,
      ].some(
        value =>
          typeof value !== 'string' || !value.trim() || value.includes('\0'),
      ) ||
      !Number.isSafeInteger(scope.keyEpoch) ||
      scope.keyEpoch < 0 ||
      scope.keyEpoch > 4294967295
    )
      return undefined;

    return {
      ...scope,
      agent: canonicalizeScheme(scope.agent),
      drive: canonicalizeScheme(scope.drive),
      portalUrl: portal.origin + portal.pathname.replace(/\/+$/, ''),
    };
  } catch {
    return undefined;
  }
}
