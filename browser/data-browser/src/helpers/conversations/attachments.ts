/**
 * Attachments in encrypted conversations: the shape they have inside a sealed
 * message, the limits on them, and the rules for showing them safely.
 *
 * An attachment is encrypted on the sender's device under a random key. The
 * ciphertext is stored as a blob; everything that identifies it (its name, its
 * real type, its key) lives only inside the sealed message. See
 * `planning/encrypted-conversations.md`.
 */

/** The largest attachment, in bytes. The wasm module holds the plaintext, the
 *  ciphertext and key material at once (about three times the file), and the
 *  server refuses bodies above 47.9 MiB. Larger files need chunked encryption. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** The most files one message carries. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** What the carrier File of every attachment says it is: the real name and type
 *  are inside the sealed message, and the host learns only a size. */
export const CARRIER_FILENAME = 'attachment';
export const CARRIER_MIMETYPE = 'application/octet-stream';

/** An attachment as referenced from inside a sealed message. */
export interface SealedAttachment {
  /** `atomic:blob:<blake3 of the ciphertext>`. */
  blob: string;
  /** The file's own key, base64url. */
  key: string;
  name: string;
  /** The type the sender gave. Untrusted: see {@link isRasterImage}. */
  type: string;
  /** Size of the plaintext in bytes. */
  size: number;
  width?: number;
  height?: number;
}

export type AttachmentRefusal =
  | { reason: 'too-large'; name: string; max: number }
  | { reason: 'too-many'; max: number };

/**
 * Whether `added` may join the `current` files of a message. `undefined` when
 * it may, otherwise why not. Both limits are checked before anything is
 * encrypted.
 */
export function refuseAttachments(
  current: readonly { size: number }[],
  added: readonly { name: string; size: number }[],
): AttachmentRefusal | undefined {
  const tooLarge = added.find(file => file.size > MAX_ATTACHMENT_BYTES);

  if (tooLarge) {
    return {
      reason: 'too-large',
      name: tooLarge.name,
      max: MAX_ATTACHMENT_BYTES,
    };
  }

  if (current.length + added.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { reason: 'too-many', max: MAX_ATTACHMENTS_PER_MESSAGE };
  }

  return undefined;
}

/** A refusal in words, for the error thrown when a caller skipped the check.
 *  The UI checks as files are added and has its own, translated, wording. */
export function describeRefusal(refusal: AttachmentRefusal): string {
  return refusal.reason === 'too-large'
    ? /* @wc-ignore */ `${refusal.name} is larger than ${refusal.max / 1024 / 1024} MiB, the limit for one attachment.`
    : /* @wc-ignore */ `A message can have at most ${refusal.max} attachments.`;
}

const BLOB_REFERENCE = /^(?:atomic|did:ad):blob:([0-9a-f]{64})$/;
const FILE_KEY = /^[A-Za-z0-9_-]{43}$/;

/** The hash in a `atomic:blob:<hash>` reference, or `undefined`. */
export function hashOfBlobReference(blob: string): string | undefined {
  return BLOB_REFERENCE.exec(blob)?.[1];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * The attachments of a decrypted payload. Tolerant on purpose: a payload from
 * a client that does not know attachments has none, and an entry that does not
 * make sense is skipped instead of failing the message around it. At most
 * {@link MAX_ATTACHMENTS_PER_MESSAGE} entries are read, whatever a sender put
 * in.
 */
export function parseAttachments(
  value: unknown,
): SealedAttachment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attachments: SealedAttachment[] = [];

  for (const entry of value) {
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;

    if (!entry || typeof entry !== 'object') continue;

    const { blob, key, name, type, size, width, height } = entry;

    if (
      typeof blob !== 'string' ||
      !hashOfBlobReference(blob) ||
      typeof key !== 'string' ||
      !FILE_KEY.test(key) ||
      typeof name !== 'string' ||
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size < 0
    ) {
      continue;
    }

    attachments.push({
      blob,
      key,
      name,
      type: typeof type === 'string' ? type : '',
      size,
      width: positiveInteger(width),
      height: positiveInteger(height),
    });
  }

  return attachments.length > 0 ? attachments : undefined;
}

/**
 * The only types that are previewed inline. The type comes from the sender, so
 * it decides nothing else: anything off this list is offered as a download of
 * `application/octet-stream`. Above all no `text/html` or SVG is ever turned
 * into an object URL that could be opened, because this origin holds the
 * agent's key.
 */
const RASTER_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export function isRasterImage(type: string): boolean {
  return RASTER_IMAGE_TYPES.has(type.toLowerCase());
}

/** A name that is safe to give a download: no path, no control characters. */
export function safeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);

  return cleaned === '' ? 'attachment' : cleaned;
}
