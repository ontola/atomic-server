import { decodeB64, encodeB64Url } from './base64.js';

/**
 * Device-pairing envelope: the payload behind the `atomic://pair` QR code /
 * deep link (see `planning/device-pairing.md`). One format, two kinds:
 *
 * - `onboard` — routing **plus the agent secret**, for a fresh device that
 *   doesn't hold the agent yet. The QR is a bearer credential: render it only
 *   behind an explicit user action, and treat it like the copy-secret button.
 * - `pair` — routing only, for a device that already holds the agent. A
 *   scanned `pair` envelope grants nothing by itself: the dialed peer still
 *   has to prove the same agent key over AUTH.
 *
 * Wire form: `atomic://pair?p=<base64url(json)>`. The same string renders as
 * a QR and works as a tap/paste deep link.
 */
export type PairingEnvelope = {
  v: 1;
  kind: 'onboard' | 'pair';
  /** Agent secret (base64 secret JSON) — present iff kind is `onboard`. */
  secret?: string;
  /** Iroh node identity of the issuing device: `did:ad:node:<64 hex>`. */
  node: string;
  /** Optional http(s) fast path (LAN/WS) — a routing hint, never identity. */
  url?: string;
  /** Which drives this pairing syncs. `"*"` = all of the agent's drives. */
  drives: '*' | string[];
};

export const PAIRING_URI_PREFIX = 'atomic://pair?p=';

/**
 * Why decoding failed. `unsupported-version` deserves its own UI ("update the
 * app") — per the plan, an unknown `v` must never be best-effort parsed.
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

const NODE_DID_PREFIX = 'did:ad:node:';

function isValidNodeDid(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(NODE_DID_PREFIX)) {
    return false;
  }

  const raw = value.slice(NODE_DID_PREFIX.length);

  return /^[0-9a-f]{64}$/i.test(raw);
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
    value.every(entry => typeof entry === 'string' && entry.length > 0)
  );
}

/** Serialize an envelope into its `atomic://pair?p=…` QR / deep-link form. */
export function encodePairingEnvelope(envelope: PairingEnvelope): string {
  // Round-trip through the validator so we can never mint a QR this module
  // would refuse to scan.
  const json = JSON.stringify(envelope);
  validateEnvelope(JSON.parse(json));

  return `${PAIRING_URI_PREFIX}${encodeB64Url(new TextEncoder().encode(json))}`;
}

/**
 * Parse and strictly validate a scanned/pasted pairing payload. Accepts the
 * full `atomic://pair?p=…` URI or the bare base64url payload. Throws
 * {@link PairingEnvelopeError} — check `code === 'unsupported-version'` to
 * show an "update the app" message instead of a generic scan error.
 */
export function decodePairingEnvelope(input: string): PairingEnvelope {
  const trimmed = input.trim();
  const payload = trimmed.startsWith(PAIRING_URI_PREFIX)
    ? trimmed.slice(PAIRING_URI_PREFIX.length)
    : trimmed;

  if (!payload || /[^A-Za-z0-9_-]/.test(payload)) {
    throw new PairingEnvelopeError(
      'malformed',
      'Not a pairing code: expected an atomic://pair link.',
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeB64(payload)));
  } catch {
    throw new PairingEnvelopeError(
      'malformed',
      'Could not read the pairing code — it may be damaged or truncated.',
    );
  }

  return validateEnvelope(parsed);
}

function validateEnvelope(parsed: unknown): PairingEnvelope {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PairingEnvelopeError('malformed', 'Pairing payload is not an object.');
  }

  const candidate = parsed as Record<string, unknown>;

  if (candidate.v !== 1) {
    throw new PairingEnvelopeError(
      'unsupported-version',
      'This pairing code was made by a newer version of Atomic — update this app to use it.',
    );
  }

  if (candidate.kind !== 'onboard' && candidate.kind !== 'pair') {
    throw new PairingEnvelopeError('malformed', 'Unknown pairing kind.');
  }

  if (candidate.kind === 'onboard') {
    if (typeof candidate.secret !== 'string' || candidate.secret.length === 0) {
      throw new PairingEnvelopeError(
        'malformed',
        'Onboarding code is missing the identity it should carry.',
      );
    }
  } else if (candidate.secret !== undefined) {
    // A routing-only envelope must never smuggle a secret: fail loudly
    // rather than silently importing an identity the user didn't ask for.
    throw new PairingEnvelopeError(
      'malformed',
      'A pair code must not carry an identity.',
    );
  }

  if (!isValidNodeDid(candidate.node)) {
    throw new PairingEnvelopeError(
      'malformed',
      'Pairing code carries an invalid node identity.',
    );
  }

  if (candidate.url !== undefined && !isValidUrl(candidate.url)) {
    throw new PairingEnvelopeError(
      'malformed',
      'Pairing code carries an invalid server URL.',
    );
  }

  if (!isValidDrives(candidate.drives)) {
    throw new PairingEnvelopeError(
      'malformed',
      'Pairing code does not say which drives to sync.',
    );
  }

  return {
    v: 1,
    kind: candidate.kind,
    ...(candidate.kind === 'onboard' ? { secret: candidate.secret as string } : {}),
    node: candidate.node as string,
    ...(candidate.url !== undefined ? { url: candidate.url as string } : {}),
    drives: candidate.drives as '*' | string[],
  };
}
