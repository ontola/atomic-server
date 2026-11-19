import type { Resource } from './resource.js';
import type { Store } from './store.js';
import { canonicalizeScheme } from './subject.js';

export interface AttachmentManifest {
  readonly files: readonly {
    readonly subject: string;
    readonly hash: string;
    readonly chunks: readonly string[];
  }[];
}
export interface ResourceAttachmentEvidence {
  readonly subject: string;
  readonly version?: string;
  readonly manifest?: AttachmentManifest;
  readonly state: 'confirmed' | 'unknown';
  readonly confirmedAt?: number;
}
export interface SerializedVaultAttachmentReceipt {
  readonly subject: string;
  readonly manifest: AttachmentManifest;
  readonly confirmedAt: number;
}
export interface ResourceAttachmentEvidenceProvider {
  getResourceAttachmentEvidence(
    subjects: string[],
  ): Promise<ResourceAttachmentEvidence[] | undefined>;
}
export type AttachmentCopyStatus = Readonly<{
  state:
    | 'confirmed'
    | 'pending'
    | 'unknown'
    | 'unavailable'
    | 'error'
    | 'not-configured';
  confirmedAt?: number;
  error?: string;
}>;
export interface ResourceAttachmentSyncStatus {
  readonly required: boolean;
  readonly manifest?: AttachmentManifest;
  readonly local: AttachmentCopyStatus;
  readonly server: AttachmentCopyStatus & { readonly url?: string };
  readonly peers: readonly (AttachmentCopyStatus & {
    readonly connectionId: string;
    readonly storageId?: string;
    readonly generation?: string;
  })[];
}

const P = 'https://atomicdata.dev/properties/';
const HASH = /^[a-f0-9]{64}$/;

const blobHash = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const hash = value.replace(/^(atomic:blob:|did:ad:blob:)/, '').toLowerCase();

  return /^(atomic:blob:|did:ad:blob:)/.test(value) && HASH.test(hash)
    ? hash
    : undefined;
};

export function parseAttachmentManifest(
  value: unknown,
): AttachmentManifest | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('files' in value) ||
    !Array.isArray(value.files) ||
    value.files.length > 128
  )
    return undefined;
  const files: AttachmentManifest['files'][number][] = [];
  let previous = '';

  for (const file of value.files) {
    if (
      !file ||
      typeof file.subject !== 'string' ||
      !file.subject ||
      file.subject.length > 4096 ||
      /[\0#?]/.test(file.subject) ||
      canonicalizeScheme(file.subject) !== file.subject ||
      file.subject <= previous ||
      !HASH.test(file.hash) ||
      !Array.isArray(file.chunks) ||
      file.chunks.length > 4096 ||
      !file.chunks.every(
        (hash: unknown) => typeof hash === 'string' && HASH.test(hash),
      )
    )
      return undefined;
    previous = file.subject;
    files.push(
      Object.freeze({
        subject: file.subject,
        hash: file.hash,
        chunks: Object.freeze([...file.chunks]),
      }),
    );
  }

  if (
    files.reduce((sum, file) => sum + file.chunks.length, 0) > 4096 ||
    new TextEncoder().encode(JSON.stringify({ files })).length >= 48 * 1024
  )
    return undefined;

  return Object.freeze({ files: Object.freeze(files) });
}

export function attachmentManifestKey(manifest: AttachmentManifest): string {
  return JSON.stringify(manifest);
}

/** Read only current loaded state. No HTTP, storage reads or mutation in getters. */
export function resourceAttachmentDescriptor(
  store: Store,
  root: Resource,
): {
  required: boolean;
  manifest?: AttachmentManifest;
  dependencies: string[];
} {
  const dependencies = [store.normalizeSubject(root.subject)];
  const unknown = () => ({ required: true, dependencies });
  const usable = (resource: Resource) =>
    !resource.loading &&
    !resource.error &&
    !store.isDestroyed(resource.subject) &&
    !store.hasPendingDestroy(resource.subject) &&
    resource.hasLoroDoc();
  if (!usable(root)) return unknown();
  const attachments = root.get(`${P}attachments`);
  if (
    attachments !== undefined &&
    (!Array.isArray(attachments) ||
      attachments.length > 128 ||
      attachments.some(id => typeof id !== 'string' || !id))
  )
    return unknown();
  const resources = [root];

  for (const id of (attachments as string[] | undefined) ?? []) {
    const subject = store.normalizeSubject(id);
    if (dependencies.includes(subject)) continue;
    dependencies.push(subject);
    const child = store.resources.get(subject);
    if (!child || !usable(child)) return unknown();
    resources.push(child);
  }

  const files: AttachmentManifest['files'][number][] = [];

  for (const resource of resources) {
    const classes = resource.get(`${P}isA`);
    const isFile =
      Array.isArray(classes) &&
      classes.includes('https://atomicdata.dev/classes/File');
    const blob = resource.get(`${P}blob`);
    const chunks = resource.get(`${P}chunks`);
    const internal = resource.get(`${P}internalId`);
    const download = resource.get(`${P}downloadURL`);

    if (
      !isFile &&
      blob === undefined &&
      chunks === undefined &&
      download === undefined
    ) {
      if (resource !== root) return unknown();
      continue;
    }

    const whole =
      typeof internal === 'string' && HASH.test(internal)
        ? internal
        : undefined;
    let hash: string | undefined;
    let ordered: string[] = [];
    if (
      chunks !== undefined &&
      (!Array.isArray(chunks) || chunks.length > 4096 || !chunks.length)
    )
      return unknown();

    if (Array.isArray(chunks) && chunks.length) {
      ordered = chunks.map(blobHash) as string[];
      if (ordered.some(value => !value) || !whole) return unknown();
      hash = whole;
      if (blob !== undefined && blobHash(blob) !== hash) return unknown();
    } else {
      hash = blob !== undefined ? blobHash(blob) : whole;
      if (!hash || (internal !== undefined && whole !== hash)) return unknown();
    }

    files.push({
      subject: store.normalizeSubject(resource.subject),
      hash,
      chunks: ordered,
    });
  }

  files.sort((a, b) =>
    a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0,
  );
  const manifest = parseAttachmentManifest({ files });

  return manifest
    ? { required: !!files.length, manifest, dependencies }
    : unknown();
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
