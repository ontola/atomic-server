import { canonicalizeScheme } from './subject.js';

/** Scope of a server acknowledgement; never shared between accounts or hubs. */
export interface ResourceSyncScope {
  agent: string;
  serverUrl: string;
}

export interface StoredServerReceipt {
  drive: string;
  version: Record<string, number>;
  confirmedAt: number;
  barrier: string;
  storageId: string;
  generation: string;
}

export interface SerializedServerReceipt {
  subject: string;
  version: Record<string, number>;
  confirmedAt: number;
  stored?: StoredServerReceipt;
}

export interface ResourceSyncEvidence {
  subject: string;
  snapshot: Uint8Array | null;
  serverReceipt?: SerializedServerReceipt;
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
export function parseSerializedServerReceipt(
  value: unknown,
): SerializedServerReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Partial<SerializedServerReceipt>;

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

  let stored: StoredServerReceipt | undefined;

  if (row.stored !== undefined) {
    const candidate = row.stored;
    if (!candidate || typeof candidate !== 'object') return undefined;
    const parsed = parseSerializedServerReceipt({
      subject: row.subject,
      version: candidate?.version,
      confirmedAt: candidate?.confirmedAt,
    });
    if (
      !parsed ||
      !Object.keys(parsed.version).length ||
      typeof candidate.drive !== 'string' ||
      !candidate.drive ||
      typeof candidate.barrier !== 'string' ||
      !candidate.barrier ||
      !/^[a-f0-9]{64}$/.test(candidate.storageId) ||
      !/^[a-f0-9]{64}$/.test(candidate.generation)
    )
      return undefined;
    stored = {
      ...candidate,
      drive: canonicalizeScheme(candidate.drive),
      version: parsed.version,
    };
  }

  return {
    subject: canonicalizeScheme(row.subject),
    version,
    confirmedAt: row.confirmedAt!,
    ...(stored ? { stored } : {}),
  };
}
