import { canonicalizeScheme } from './subject.js';

/** Private local proof scope. Managed account IDs must never be displayed. */
export interface VaultSyncScope {
  managedAccount: string;
  agent: string;
  portalUrl: string;
  drive: string;
  drivePseudonym: string;
  keyEpoch: number;
}

/** Scope of a server acknowledgement; never shared between accounts or hubs. */
export interface ResourceSyncScope {
  agent: string;
  serverUrl: string;
}

/** A destination's proof that it holds a resource at an exact version. */
export interface SerializedReceipt {
  subject: string;
  version: Record<string, number>;
  confirmedAt: number;
}

export interface ResourceSyncEvidence {
  subject: string;
  snapshot: Uint8Array | null;
  serverReceipt?: SerializedReceipt;
}

export interface ResourceVaultEvidence {
  subject: string;
  snapshot: Uint8Array | null;
  vaultReceipt?: SerializedReceipt;
}

export function normalizeResourceSyncScope(
  scope: ResourceSyncScope,
): ResourceSyncScope | undefined {
  try {
    const url = new URL(scope.serverUrl);

    if (
      !scope.agent ||
      scope.agent.includes('\0') ||
      !['http:', 'https:'].includes(url.protocol)
    )
      return undefined;

    return { agent: canonicalizeScheme(scope.agent), serverUrl: url.origin };
  } catch {
    return undefined;
  }
}

/** Fail closed for malformed persisted data, including unsafe JS integers. */
export function parseSerializedReceipt(
  value: unknown,
): SerializedReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Partial<SerializedReceipt>;

  if (
    typeof row.subject !== 'string' ||
    !row.subject ||
    row.subject.includes('\0') ||
    !Number.isSafeInteger(row.confirmedAt) ||
    row.confirmedAt! < 0 ||
    !row.version ||
    typeof row.version !== 'object' ||
    Array.isArray(row.version)
  )
    return undefined;

  const version: Record<string, number> = {};

  for (const [peer, counter] of Object.entries(row.version)) {
    if (
      !/^(0|[1-9]\d*)$/.test(peer) ||
      BigInt(peer) > 18446744073709551615n ||
      !Number.isSafeInteger(counter) ||
      counter < 0 ||
      counter > 2147483647
    )
      return undefined;
    version[peer] = counter;
  }

  return {
    subject: canonicalizeScheme(row.subject),
    version,
    confirmedAt: row.confirmedAt!,
  };
}

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
