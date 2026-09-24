/**
 * Device-pairing envelope. A pairing code is a node identifier with routing
 * hints in the query — the same shape as the `?drive=` hint on a resource:
 *
 *     atomic:node:{64 hex}?v=1&drives=*
 *
 * **A pairing code is routing only.** It says where to reach a node and which
 * drives to sync; it grants nothing. The dialed peer still has to prove it
 * holds the same agent key over AUTH before a single resource crosses.
 *
 * Legacy `atomic://pair?v=1&node=…` codes still parse. New codes never use a
 * reserved `pair` / `open` word: a node identifier starts pairing, anything
 * else navigates.
 *
 * See `planning/atomic-scheme.md` and issue #1584.
 */
import {
  ATOMIC_NODE_PREFIX,
  ATOMIC_PREFIX,
  DID_AD_NODE_PREFIX,
  isLegacyAtomicLink,
  isNodeSubject,
  nodeId,
  nodeSubject,
  startsWithAtomicScheme,
} from './subject.js';

export type PairingEnvelope = {
  v: 1;
  /** Iroh node identity of the issuing device: `atomic:node:<64 hex>`. */
  node: string;
  /** Optional http(s) fast path (LAN/WS) — a routing hint, never identity. */
  url?: string;
  /** Which drives this pairing syncs. `"*"` = all of the agent's drives. */
  drives: '*' | string[];
};

/** New pairing codes are the node identifier plus query hints. */
export const PAIRING_URI_PREFIX = `${ATOMIC_NODE_PREFIX}`;

/** Legacy hierarchical link (`atomic://pair`, `atomic://open`). */
export const LEGACY_ATOMIC_LINK_PREFIX = 'atomic://';

/** Legacy deep-link form, still accepted on input. */
export const LEGACY_PAIRING_URI_PREFIX = 'atomic://pair?';

function toOpaqueAtomic(raw: string): string {
  return isLegacyAtomicLink(raw)
    ? 'atomic:' + raw.slice(LEGACY_ATOMIC_LINK_PREFIX.length)
    : raw;
}

/** Body after `atomic:` / `atomic://`, with query/fragment stripped. */
function opaqueAtomicBody(raw: string): string | undefined {
  const opaque = toOpaqueAtomic(raw);

  if (!startsWithAtomicScheme(opaque)) {
    return undefined;
  }

  return opaque.slice(ATOMIC_PREFIX.length).split(/[?#]/)[0];
}

/** True for a legacy `atomic://pair?…` / `atomic:pair?…` pairing code. */
export function isLegacyPairingUri(raw: string): boolean {
  return opaqueAtomicBody(raw) === 'pair';
}

/** True when `raw` should start pairing rather than navigate. */
export function looksLikePairingUri(raw: string): boolean {
  return (
    isNodeSubject(toOpaqueAtomic(raw).split(/[?#]/)[0]) ||
    isLegacyPairingUri(raw)
  );
}

/** Universal-link origin for sharing in chat (where only `scheme://` auto-links). */
export const PAIRING_SHARE_ORIGIN = 'https://atomicserver.eu';

/**
 * Why decoding failed. `unsupported-version` deserves its own UI ("update the
 * app") — an unknown `v` must never be best-effort parsed.
 */
export class PairingEnvelopeError extends Error {
  public constructor(
    public readonly code: 'unsupported-version' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'PairingEnvelopeError';
  }
}

function isValidNodeDid(value: unknown): value is string {
  if (typeof value !== 'string' || !isNodeSubject(value)) {
    return false;
  }

  const raw = nodeId(value);

  return !!raw && /^[0-9a-f]{64}$/i.test(raw);
}

function isValidUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(value);

    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidDrives(value: unknown): value is '*' | string[] {
  if (value === '*') {
    return true;
  }

  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      entry => typeof entry === 'string' && entry.length > 0 && entry !== '*',
    )
  );
}

function assertValid(envelope: PairingEnvelope): PairingEnvelope {
  if (envelope.v !== 1) {
    throw new PairingEnvelopeError(
      'unsupported-version',
      'This pairing code was made by a newer version of Atomic — update this app to use it.',
    );
  }

  if (!isValidNodeDid(envelope.node)) {
    throw new PairingEnvelopeError(
      'malformed',
      'Pairing code carries an invalid node identity.',
    );
  }

  const id = nodeId(envelope.node);

  if (id) {
    envelope = { ...envelope, node: nodeSubject(id) };
  }

  if (envelope.url !== undefined && !isValidUrl(envelope.url)) {
    throw new PairingEnvelopeError(
      'malformed',
      'Pairing code carries an invalid server URL.',
    );
  }

  if (!isValidDrives(envelope.drives)) {
    throw new PairingEnvelopeError(
      'malformed',
      'Pairing code does not say which drives to sync.',
    );
  }

  return envelope;
}

function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ':').replace(/%2A/gi, '*');
}

function queryOf(envelope: PairingEnvelope): string {
  const params = [`v=${envelope.v}`];

  if (envelope.url !== undefined) {
    params.push(`url=${encodeURIComponent(envelope.url)}`);
  }

  if (envelope.drives === '*') {
    params.push('drives=*');
  } else {
    for (const drive of envelope.drives) {
      params.push(`drives=${encodeValue(drive)}`);
    }
  }

  return params.join('&');
}

/** Serialize an envelope as `atomic:node:{id}?v=1&drives=…`. */
export function encodePairingEnvelope(envelope: PairingEnvelope): string {
  assertValid(envelope);
  const id = nodeId(envelope.node) ?? envelope.node;

  return `${nodeSubject(id)}?${queryOf(envelope)}`;
}

function parseQuery(query: string): URLSearchParams {
  return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
}

function envelopeFromParams(
  node: string,
  params: URLSearchParams,
): PairingEnvelope {
  const version = params.get('v');

  if (version !== null && version !== '1') {
    throw new PairingEnvelopeError(
      'unsupported-version',
      'This pairing code was made by a newer version of Atomic — update this app to use it.',
    );
  }

  if (params.has('secret')) {
    throw new PairingEnvelopeError(
      'malformed',
      'This code tries to hand over an account. Pairing codes only say where to reach a device — refusing it.',
    );
  }

  const drives = params.getAll('drives');
  const url = params.get('url');

  return assertValid({
    v: 1,
    node,
    ...(url !== null ? { url } : {}),
    drives:
      drives.length === 0 || (drives.length === 1 && drives[0] === '*')
        ? '*'
        : (drives as string[] | '*'),
  });
}

/**
 * Parse a scanned/pasted pairing code. Accepts:
 * - `atomic:node:{id}?v=1&drives=*` (canonical)
 * - `did:ad:node:{id}` (bare node, all drives)
 * - `atomic://pair?v=1&node=…` (legacy)
 * - `https://atomicserver.eu/node/{id}?…` (share link)
 */
export function decodePairingEnvelope(input: string): PairingEnvelope {
  const trimmed = input.trim();

  if (
    trimmed.startsWith(PAIRING_SHARE_ORIGIN + '/node/') ||
    trimmed.startsWith(PAIRING_SHARE_ORIGIN + '/pair')
  ) {
    try {
      const url = new URL(trimmed);
      const id = url.pathname.split('/').filter(Boolean)[1];
      const node = id && isNodeSubject(id) ? id : nodeSubject(id ?? '');

      return envelopeFromParams(node, url.searchParams);
    } catch {
      throw new PairingEnvelopeError('malformed', 'Not a pairing code.');
    }
  }

  const opaque = toOpaqueAtomic(trimmed);

  if (isNodeSubject(opaque.split(/[?#]/)[0])) {
    const node = opaque.split(/[?#]/)[0];
    const qIndex = opaque.indexOf('?');
    const params =
      qIndex === -1 ? new URLSearchParams() : parseQuery(opaque.slice(qIndex));

    return envelopeFromParams(node, params);
  }

  if (isLegacyPairingUri(trimmed)) {
    const qIndex = opaque.indexOf('?');
    const query = qIndex === -1 ? '' : opaque.slice(qIndex + 1);
    const params = parseQuery(query);
    const node = params.get('node') ?? '';

    return envelopeFromParams(node, params);
  }

  throw new PairingEnvelopeError(
    'malformed',
    'Not a pairing code: expected an atomic:node identifier.',
  );
}

export { ATOMIC_NODE_PREFIX, DID_AD_NODE_PREFIX };
