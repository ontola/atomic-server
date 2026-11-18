import {
  parseAttachmentManifest,
  type AttachmentManifest,
} from './resource-attachment-evidence.js';
import { decodeB64 } from './base64.js';
import { LoroLoader } from './loro-loader.js';
import type { ReplicaIdentity } from './peer-receipts.js';

/** A snapshot of native-process live evidence, never a persisted backup ledger. */
export interface ResourcePeerEvidence {
  readonly agent: string;
  readonly agentGeneration: string;
  readonly connections: readonly ResourcePeerEvidenceConnection[];
}

export interface ResourcePeerEvidenceConnection {
  readonly connectionId: string;
  readonly drive: string;
  readonly peerAgent: string;
  readonly receipts: readonly ResourcePeerEvidenceReceipt[];
  readonly attachmentReceipts?: readonly (ResourcePeerEvidenceReceipt & {
    readonly manifest: AttachmentManifest;
  })[];
}

export interface ResourcePeerEvidenceReceipt {
  readonly subject: string;
  /** Encoded exact Loro version vector confirmed by the native peer. */
  readonly version: string;
  readonly confirmedAt: number;
  readonly source: ReplicaIdentity;
  readonly replica: ReplicaIdentity;
}

/** Optional capability; ordinary browser workers and older native hosts omit it. */
export interface ResourcePeerEvidenceProvider {
  getResourcePeerEvidence(
    subjects: string[],
  ): Promise<ResourcePeerEvidence | undefined>;
}

/** Host-owned session namespaces; browser transport IDs are unprefixed tokens. */
export function isNativePeerConnectionId(value: string): boolean {
  return value.startsWith('iroh:') || value.startsWith('webrtc:');
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function identity(value: unknown): value is ReplicaIdentity {
  return (
    record(value) &&
    typeof value.storageId === 'string' &&
    typeof value.generation === 'string' &&
    /^[a-f0-9]{64}$/.test(value.storageId) &&
    /^[a-f0-9]{64}$/.test(value.generation)
  );
}

function version(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 16384 ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) ||
    !LoroLoader.isLoaded()
  )
    return false;

  try {
    const vv = LoroLoader.Loro.VersionVector.decode(decodeB64(value)).toJSON();

    return (
      vv.size > 0 &&
      [...vv.values()].every(
        counter => Number.isSafeInteger(counter) && counter > 0,
      )
    );
  } catch {
    return false;
  }
}

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
  const connections: ResourcePeerEvidenceConnection[] = [];
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
      connection.receipts.length > 128
    )
      return undefined;
    ids.add(connection.connectionId);
    const receipts: ResourcePeerEvidenceReceipt[] = [];
    const subjects = new Set<string>();

    for (const receipt of connection.receipts) {
      if (
        !record(receipt) ||
        !text(receipt.subject) ||
        subjects.has(receipt.subject) ||
        !version(receipt.version) ||
        typeof receipt.confirmedAt !== 'number' ||
        !Number.isSafeInteger(receipt.confirmedAt) ||
        receipt.confirmedAt < 0 ||
        !identity(receipt.source) ||
        !identity(receipt.replica)
      )
        return undefined;
      subjects.add(receipt.subject);
      receipts.push(
        Object.freeze({
          subject: receipt.subject,
          version: receipt.version,
          confirmedAt: receipt.confirmedAt,
          source: Object.freeze({ ...receipt.source }),
          replica: Object.freeze({ ...receipt.replica }),
        }),
      );
    }

    const attachmentReceipts: (ResourcePeerEvidenceReceipt & {
      manifest: AttachmentManifest;
    })[] = [];

    if (connection.attachmentReceipts !== undefined) {
      if (
        !Array.isArray(connection.attachmentReceipts) ||
        connection.attachmentReceipts.length > 128
      )
        return undefined;
      const seen = new Set<string>();

      for (const receipt of connection.attachmentReceipts) {
        const manifest = parseAttachmentManifest(receipt?.manifest);
        if (
          !record(receipt) ||
          !text(receipt.subject) ||
          seen.has(receipt.subject) ||
          !version(receipt.version) ||
          !manifest ||
          typeof receipt.confirmedAt !== 'number' ||
          !Number.isSafeInteger(receipt.confirmedAt) ||
          receipt.confirmedAt < 0 ||
          !identity(receipt.source) ||
          !identity(receipt.replica)
        )
          return undefined;
        seen.add(receipt.subject);
        attachmentReceipts.push(
          Object.freeze({
            subject: receipt.subject,
            version: receipt.version,
            manifest,
            confirmedAt: receipt.confirmedAt,
            source: receipt.source,
            replica: receipt.replica,
          }),
        );
      }
    }

    connections.push(
      Object.freeze({
        connectionId: connection.connectionId,
        drive: connection.drive,
        peerAgent: connection.peerAgent,
        receipts: Object.freeze(receipts),
        attachmentReceipts: Object.freeze(attachmentReceipts),
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
