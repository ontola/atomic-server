import { decodeB64 } from './base64.js';
import { LoroLoader } from './loro-loader.js';
import {
  parseAttachmentManifest,
  type AttachmentManifest,
} from './attachment-manifest.js';
import type {
  BrowserReplicaReceipt,
  ReplicaIdentity,
} from './peer-receipts.js';
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

/** The destination a stored receipt is addressed to. */
export type ReceiptScope =
  | { server: ResourceSyncScope }
  | { vault: VaultSyncScope };

/** A destination's stored proof that it holds a resource at an exact version.
 * With a `manifest` it proves the file contents (`version` is then empty),
 * without one the resource's own document.
 */
export interface SerializedReceipt {
  subject: string;
  version: Record<string, number>;
  manifest?: AttachmentManifest;
  confirmedAt: number;
}

/** Stored bytes of one resource and the receipts a destination holds for them. */
export interface ResourceReceipts {
  subject: string;
  snapshot: Uint8Array | null;
  receipts: SerializedReceipt[];
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

  const manifest =
    row.manifest === undefined
      ? undefined
      : parseAttachmentManifest(row.manifest);
  if (row.manifest !== undefined && !manifest) return undefined;

  return {
    subject: canonicalizeScheme(row.subject),
    version,
    ...(manifest && { manifest }),
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

export interface ResourceAttachmentEvidence {
  readonly subject: string;
  readonly version?: string;
  readonly manifest?: AttachmentManifest;
  readonly state: 'confirmed' | 'unknown';
  readonly confirmedAt?: number;
}
export interface ResourceAttachmentEvidenceProvider {
  getResourceAttachmentEvidence(
    subjects: string[],
  ): Promise<ResourceAttachmentEvidence[] | undefined>;
}

/** The one shape every destination reports in: the server, a Vault drive or a
 * peer. Transports only produce these; the tracker decides what they prove.
 * A receipt with a `manifest` proves file contents, one without proves the
 * resource's own document.
 */
export interface Receipt {
  /** `local`, `server`, `vault:<drive>`, `peer:<id>` (browser) or `native:<id>`. */
  destination: string;
  subject: string;
  version: Record<string, number>;
  manifest?: AttachmentManifest;
  /** Unknown for proof recovered by re-verifying stored bytes. */
  confirmedAt?: number;
  /** Peer sessions only: who holds the copy, and in which backing storage. */
  session?: {
    drive: string;
    peerAgent: string;
    source?: ReplicaIdentity;
    replica: ReplicaIdentity;
  };
}

/** Decode an encoded Loro version vector; empty or non-positive ones prove nothing. */
export function decodeVersion(
  value: string,
): Record<string, number> | undefined {
  if (!LoroLoader.isLoaded()) return undefined;

  try {
    const vv = LoroLoader.Loro.VersionVector.decode(decodeB64(value)).toJSON();

    return vv.size > 0 &&
      [...vv.values()].every(count => Number.isSafeInteger(count) && count > 0)
      ? Object.fromEntries(vv)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A browser peer's storage receipt, metadata or file contents, as a Receipt. */
export function browserReceipt(
  receipt: BrowserReplicaReceipt,
): Receipt | undefined {
  const version = decodeVersion(receipt.version);

  return version
    ? {
        destination: `peer:${receipt.connectionId}`,
        subject: receipt.subject,
        version,
        manifest: receipt.manifest,
        confirmedAt: receipt.confirmedAt,
        session: {
          drive: receipt.drive,
          peerAgent: receipt.peerAgent,
          source: receipt.source,
          replica: receipt.replica,
        },
      }
    : undefined;
}

/** Live evidence of the native process, never a persisted backup ledger. */
export interface ResourcePeerEvidence {
  readonly agent: string;
  readonly agentGeneration: string;
  readonly connections: readonly {
    readonly connectionId: string;
    readonly drive: string;
    readonly peerAgent: string;
    /** Resource and file-contents receipts alike, addressed to `native:<id>`. */
    readonly receipts: readonly Receipt[];
  }[];
}

/** Optional capability; ordinary browser workers and older native hosts omit it. */
export interface ResourcePeerEvidenceProvider {
  /** The raw bridge reply; `parseResourcePeerEvidence` validates it as a whole. */
  getResourcePeerEvidence(subjects: string[]): Promise<unknown>;
}

/** Host-owned session namespaces; browser transport IDs are unprefixed tokens. */
export function isNativePeerConnectionId(value: string): boolean {
  return value.startsWith('iroh:') || value.startsWith('webrtc:');
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;
const identity = (value: unknown): value is ReplicaIdentity =>
  record(value) &&
  [value.storageId, value.generation].every(
    id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id),
  );

/** Validate the optional JSON bridge as a whole; a malformed reply cannot
 * preserve earlier confirmations or create a partial success snapshot.
 */
export function parseResourcePeerEvidence(
  value: unknown,
): ResourcePeerEvidence | undefined {
  if (
    !record(value) ||
    typeof value.agent !== 'string' ||
    value.agent.length > 4096 ||
    typeof value.agentGeneration !== 'string' ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value.agentGeneration) ||
    !Array.isArray(value.connections) ||
    value.connections.length > 256
  )
    return undefined;
  const connections: ResourcePeerEvidence['connections'][number][] = [];
  const ids = new Set<string>();

  for (const connection of value.connections) {
    if (
      !record(connection) ||
      !text(connection.connectionId) ||
      !isNativePeerConnectionId(connection.connectionId) ||
      ids.has(connection.connectionId) ||
      !text(connection.drive) ||
      !text(connection.peerAgent) ||
      !Array.isArray(connection.receipts) ||
      connection.receipts.length > 128 ||
      (connection.attachmentReceipts !== undefined &&
        (!Array.isArray(connection.attachmentReceipts) ||
          connection.attachmentReceipts.length > 128))
    )
      return undefined;
    ids.add(connection.connectionId);
    const receipts: Receipt[] = [];
    // One list of receipts; a row with a manifest proves file contents. Hosts
    // from before the lists merged send those under `attachmentReceipts`.
    const rows: unknown[] = [
      ...connection.receipts,
      ...(connection.attachmentReceipts ?? []),
    ];
    const seen = new Set<string>();

    for (const row of rows) {
      const contents = record(row) && row.manifest !== undefined;
      const manifest = contents
        ? parseAttachmentManifest(record(row) ? row.manifest : undefined)
        : undefined;
      const version =
        record(row) &&
        typeof row.version === 'string' &&
        row.version.length <= 16384 &&
        /^[A-Za-z0-9+/_-]+={0,2}$/.test(row.version)
          ? decodeVersion(row.version)
          : undefined;

      if (
        !record(row) ||
        !text(row.subject) ||
        seen.has(`${contents}:${row.subject}`) ||
        !version ||
        (contents && !manifest) ||
        !Number.isSafeInteger(row.confirmedAt) ||
        (row.confirmedAt as number) < 0 ||
        !identity(row.source) ||
        !identity(row.replica)
      )
        return undefined;
      seen.add(`${contents}:${row.subject}`);
      receipts.push(
        Object.freeze({
          destination: `native:${connection.connectionId}`,
          subject: row.subject,
          version,
          manifest,
          confirmedAt: row.confirmedAt as number,
          session: Object.freeze({
            drive: connection.drive,
            peerAgent: connection.peerAgent,
            source: Object.freeze({ ...row.source }),
            replica: Object.freeze({ ...row.replica }),
          }),
        }),
      );
    }

    connections.push(
      Object.freeze({
        connectionId: connection.connectionId,
        drive: connection.drive,
        peerAgent: connection.peerAgent,
        receipts: Object.freeze(receipts),
      }),
    );
  }

  if (!value.agent && connections.length) return undefined;

  return Object.freeze({
    agent: value.agent,
    agentGeneration: value.agentGeneration,
    connections: Object.freeze(connections),
  });
}

export function parseResourceAttachmentEvidence(
  value: unknown,
): ResourceAttachmentEvidence[] | undefined {
  if (!Array.isArray(value) || value.length > 128) return undefined;
  const out: ResourceAttachmentEvidence[] = [];
  const seen = new Set<string>();

  for (const row of value) {
    if (
      !row ||
      typeof row.subject !== 'string' ||
      !row.subject ||
      seen.has(row.subject) ||
      !['confirmed', 'unknown'].includes(row.state)
    )
      return undefined;
    seen.add(row.subject);
    const manifest =
      row.manifest === undefined
        ? undefined
        : parseAttachmentManifest(row.manifest);
    if (row.manifest !== undefined && !manifest) return undefined;
    if (
      row.state === 'confirmed' &&
      (!manifest ||
        typeof row.version !== 'string' ||
        !row.version ||
        !Number.isSafeInteger(row.confirmedAt) ||
        row.confirmedAt < 0)
    )
      return undefined;
    out.push(
      Object.freeze({
        subject: row.subject,
        version: row.version,
        manifest,
        state: row.state,
        confirmedAt: row.confirmedAt,
      }),
    );
  }

  return out;
}
