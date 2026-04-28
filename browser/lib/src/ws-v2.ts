/**
 * WebSocket Protocol v2: binary-first, unified messages.
 *
 * Frame format: [type: u8] [payload...]
 * All frames are binary WebSocket frames. No base64, no JSON for Loro bytes.
 *
 * **Canonical wire-format spec:** `docs/src/websockets.md`. When tags, flag
 * bits, or payload layouts change here, update that doc and the matching
 * Rust module (`lib/src/sync/protocol.rs`) in the same change.
 */

// ---- Message type tags ----

export const Tag = {
  AUTH: 0x01,
  AUTH_OK: 0x02,
  ERROR: 0x03,
  GET: 0x10,
  UPDATE: 0x11,
  DESTROY: 0x12,
  COMMIT: 0x13,
  COMMIT_OK: 0x14,
  SUB: 0x20,
  UNSUB: 0x21,
  SYNC: 0x30,
  SYNC_OK: 0x31,
  SYNC_DIFF: 0x32,
  SYNC_PUSH: 0x33,
  BLOB_REQUEST: 0x34,
  BLOB_RESPONSE: 0x35,
  QUERY_UPDATE: 0x36,
  EPHEMERAL: 0x40,
} as const;

// ---- UPDATE flags ----

export const Flags = {
  /** Loro snapshot (1) vs delta (0) */
  SNAPSHOT: 0b0001,
  /** A commit ID follows the subject */
  HAS_COMMIT_ID: 0b0010,
  /** Subscription push (not a GET response) */
  PUSH: 0b0100,
} as const;

/** SYNC_PUSH flags. A SYNC_PUSH run is one or more chunks; only the
 *  final chunk has LAST set. Receivers must keep reading SYNC_PUSH
 *  frames until they see this bit. */
export const SyncPushFlags = {
  LAST: 0b0001,
} as const;

// ---- Low-level read/write helpers ----

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeU16(buf: Uint8Array, offset: number, value: number): number {
  buf[offset] = (value >> 8) & 0xff;
  buf[offset + 1] = value & 0xff;

  return offset + 2;
}

function readU16(buf: Uint8Array, offset: number): [number, number] {
  return [(buf[offset] << 8) | buf[offset + 1], offset + 2];
}

function writeU32(buf: Uint8Array, offset: number, value: number): number {
  buf[offset] = (value >> 24) & 0xff;
  buf[offset + 1] = (value >> 16) & 0xff;
  buf[offset + 2] = (value >> 8) & 0xff;
  buf[offset + 3] = value & 0xff;

  return offset + 4;
}

function readU32(buf: Uint8Array, offset: number): [number, number] {
  return [
    (buf[offset] << 24) |
      (buf[offset + 1] << 16) |
      (buf[offset + 2] << 8) |
      buf[offset + 3],
    offset + 4,
  ];
}

function readStr16(buf: Uint8Array, offset: number): [string, number] {
  const [len, off] = readU16(buf, offset);
  const str = decoder.decode(buf.subarray(off, off + len));

  return [str, off + len];
}

// ---- Encoding ----

export function encodeAuth(jsonPayload: string): Uint8Array {
  const payload = encoder.encode(jsonPayload);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = Tag.AUTH;
  buf.set(payload, 1);

  return buf;
}

export function encodeGet(requestId: number, subject: string): Uint8Array {
  const subjectBytes = encoder.encode(subject);
  const buf = new Uint8Array(3 + subjectBytes.length);
  buf[0] = Tag.GET;
  writeU16(buf, 1, requestId);
  buf.set(subjectBytes, 3);

  return buf;
}

export function encodeCommit(
  requestId: number,
  commitJson: string,
): Uint8Array {
  const payload = encoder.encode(commitJson);
  const buf = new Uint8Array(3 + payload.length);
  buf[0] = Tag.COMMIT;
  writeU16(buf, 1, requestId);
  buf.set(payload, 3);

  return buf;
}

export function encodeCommitOk(
  requestId: number,
  commitJson: string,
): Uint8Array {
  const payload = encoder.encode(commitJson);
  const buf = new Uint8Array(3 + payload.length);
  buf[0] = Tag.COMMIT_OK;
  writeU16(buf, 1, requestId);
  buf.set(payload, 3);

  return buf;
}

export function encodeUpdate(
  flags: number,
  requestId: number,
  subject: string,
  commitId: string | undefined,
  loroBytes: Uint8Array,
): Uint8Array {
  const subjectBytes = encoder.encode(subject);
  const commitIdBytes = commitId ? encoder.encode(commitId) : undefined;
  const commitIdLen = commitIdBytes ? 2 + commitIdBytes.length : 0;

  const buffer = new Uint8Array(
    1 + 1 + 2 + 2 + subjectBytes.length + commitIdLen + loroBytes.length,
  );
  let offset = 0;
  buffer[offset++] = Tag.UPDATE;
  buffer[offset++] = flags;
  offset = writeU16(buffer, offset, requestId);
  offset = writeU16(buffer, offset, subjectBytes.length);
  buffer.set(subjectBytes, offset);
  offset += subjectBytes.length;

  if (commitIdBytes) {
    offset = writeU16(buffer, offset, commitIdBytes.length);
    buffer.set(commitIdBytes, offset);
    offset += commitIdBytes.length;
  }

  buffer.set(loroBytes, offset);

  return buffer;
}

export function encodeSub(driveSubject: string): Uint8Array {
  const payload = encoder.encode(driveSubject);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = Tag.SUB;
  buf.set(payload, 1);

  return buf;
}

export function encodeSync(
  driveSubject: string,
  hash: Uint8Array,
  vvJson: string,
): Uint8Array {
  const driveBytes = encoder.encode(driveSubject);
  const vvBytes = encoder.encode(vvJson);
  const buf = new Uint8Array(1 + 2 + driveBytes.length + 32 + vvBytes.length);
  let off = 0;
  buf[off++] = Tag.SYNC;
  off = writeU16(buf, off, driveBytes.length);
  buf.set(driveBytes, off);
  off += driveBytes.length;
  buf.set(hash, off);
  off += 32;
  buf.set(vvBytes, off);

  return buf;
}

export function encodeSyncPush(
  driveSubject: string,
  entries: Array<{ subject: string; loroBytes: Uint8Array }>,
  last = true,
): Uint8Array {
  const driveBytes = encoder.encode(driveSubject);
  const encodedEntries = entries.map(e => ({
    subjectBytes: encoder.encode(e.subject),
    loroBytes: e.loroBytes,
  }));
  const entrySize = encodedEntries.reduce(
    (sum, e) => sum + 2 + e.subjectBytes.length + 4 + e.loroBytes.length,
    0,
  );

  const buf = new Uint8Array(1 + 2 + driveBytes.length + 1 + 2 + entrySize);
  let off = 0;
  buf[off++] = Tag.SYNC_PUSH;
  off = writeU16(buf, off, driveBytes.length);
  buf.set(driveBytes, off);
  off += driveBytes.length;
  buf[off++] = last ? SyncPushFlags.LAST : 0;
  off = writeU16(buf, off, entries.length);

  for (const e of encodedEntries) {
    off = writeU16(buf, off, e.subjectBytes.length);
    buf.set(e.subjectBytes, off);
    off += e.subjectBytes.length;
    off = writeU32(buf, off, e.loroBytes.length);
    buf.set(e.loroBytes, off);
    off += e.loroBytes.length;
  }

  return buf;
}

export function encodeBlobRequest(hash: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + 32);
  buf[0] = Tag.BLOB_REQUEST;
  buf.set(hash, 1);

  return buf;
}

export function encodeBlobResponse(
  hash: Uint8Array,
  bytes: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(1 + 32 + bytes.length);
  buf[0] = Tag.BLOB_RESPONSE;
  buf.set(hash, 1);
  buf.set(bytes, 1 + 32);

  return buf;
}

// ---- Decoding ----

export interface DecodedUpdate {
  flags: number;
  requestId: number;
  subject: string;
  commitId: string | undefined;
  loroBytes: Uint8Array;
}

export interface DecodedGet {
  requestId: number;
  subject: string;
}

export interface DecodedCommit {
  requestId: number;
  commitJson: string;
}

export interface DecodedError {
  requestId: number;
  message: string;
}

export interface DecodedSyncOk {
  drive: string;
}

export interface DecodedSyncDiff {
  drive: string;
  pull: string[];
  push: string[];
  remove: string[];
  /** Server oplog VV per pull subject — export updates since this. */
  pullFrom: Record<string, Record<string, number>>;
}

export interface DecodedSyncPushEntry {
  subject: string;
  loroBytes: Uint8Array;
}

export interface DecodedSyncPush {
  drive: string;
  entries: DecodedSyncPushEntry[];
  /** True iff this is the final chunk of a SYNC_PUSH run. Receivers
   *  loop reading SYNC_PUSH frames until they see `last === true`. */
  last: boolean;
}

export interface DecodedBlobResponse {
  hash: Uint8Array;
  bytes: Uint8Array;
}

export function decodeUpdate(data: Uint8Array): DecodedUpdate | undefined {
  if (data.length < 6) return undefined;

  const flags = data[0];
  const [requestId, off1] = readU16(data, 1);
  const [subject, off2] = readStr16(data, off1);

  let commitId: string | undefined;
  let off = off2;

  if (flags & Flags.HAS_COMMIT_ID) {
    [commitId, off] = readStr16(data, off);
  }

  const loroBytes = data.subarray(off);

  return { flags, requestId, subject, commitId, loroBytes };
}

export function decodeGet(data: Uint8Array): DecodedGet | undefined {
  if (data.length < 3) return undefined;
  const [requestId, off] = readU16(data, 0);
  const subject = decoder.decode(data.subarray(off));

  return { requestId, subject };
}

export function decodeCommit(data: Uint8Array): DecodedCommit | undefined {
  if (data.length < 3) return undefined;
  const [requestId, off] = readU16(data, 0);
  const commitJson = decoder.decode(data.subarray(off));

  return { requestId, commitJson };
}

export function decodeError(data: Uint8Array): DecodedError | undefined {
  if (data.length < 3) return undefined;
  const [requestId, off] = readU16(data, 0);
  const message = decoder.decode(data.subarray(off));

  return { requestId, message };
}

export function decodeSyncOk(data: Uint8Array): DecodedSyncOk | undefined {
  const [drive] = readStr16(data, 0);

  return drive ? { drive } : undefined;
}

export function decodeSyncDiff(data: Uint8Array): DecodedSyncDiff | undefined {
  const [drive, off] = readStr16(data, 0);
  const json = decoder.decode(data.subarray(off));

  try {
    const { pull, push, remove = [], pullFrom = {} } = JSON.parse(json);

    return { drive, pull, push, remove, pullFrom };
  } catch {
    return undefined;
  }
}

/** Chunking thresholds — keep each WS frame under legacy 64 KiB limits. */
const SYNC_PUSH_MAX_ENTRIES = 100;
const SYNC_PUSH_MAX_BYTES = 48 * 1024;

/** Split entries into multiple SYNC_PUSH frames (last chunk flagged). */
export function encodeSyncPushChunks(
  driveSubject: string,
  entries: Array<{ subject: string; loroBytes: Uint8Array }>,
): Uint8Array[] {
  if (entries.length === 0) {
    return [encodeSyncPush(driveSubject, [], true)];
  }

  const chunks: Uint8Array[] = [];
  let start = 0;

  while (start < entries.length) {
    let end = start;
    let bytesAcc = 0;

    while (end < entries.length && end - start < SYNC_PUSH_MAX_ENTRIES) {
      const e = entries[end];
      const entryBytes =
        2 + encoder.encode(e.subject).length + 4 + e.loroBytes.length;

      if (end > start && bytesAcc + entryBytes > SYNC_PUSH_MAX_BYTES) {
        break;
      }

      bytesAcc += entryBytes;
      end += 1;
    }

    const last = end >= entries.length;
    chunks.push(encodeSyncPush(driveSubject, entries.slice(start, end), last));
    start = end;
  }

  return chunks;
}

export function decodeSyncPush(data: Uint8Array): DecodedSyncPush | undefined {
  const [drive, off1] = readStr16(data, 0);
  if (off1 >= data.length) return undefined;
  const flags = data[off1];
  const last = (flags & SyncPushFlags.LAST) !== 0;
  const [count, off2] = readU16(data, off1 + 1);
  const entries: DecodedSyncPushEntry[] = [];
  let off = off2;

  for (let i = 0; i < count; i++) {
    const [subject, sOff] = readStr16(data, off);
    const [bytesLen, bOff] = readU32(data, sOff);
    const loroBytes = data.subarray(bOff, bOff + bytesLen);
    entries.push({ subject, loroBytes });
    off = bOff + bytesLen;
  }

  return { drive, entries, last };
}

export function decodeBlobRequest(data: Uint8Array): Uint8Array | undefined {
  if (data.length < 32) return undefined;

  return data.slice(0, 32);
}

export function decodeBlobResponse(
  data: Uint8Array,
): DecodedBlobResponse | undefined {
  if (data.length < 32) return undefined;
  const hash = data.slice(0, 32);
  const bytes = data.slice(32);

  return { hash, bytes };
}

export function decodeSubject(data: Uint8Array): string {
  return decoder.decode(data);
}

export interface DecodedQueryUpdate {
  property?: string;
  value?: string;
  added: string[];
  removed: string[];
}

/**
 * Wire format (after type tag):
 *   [property_len: u16][property][value_len: u16][value]
 *   [added_count: u16] {[subject_len: u16][subject]}
 *   [removed_count: u16] {[subject_len: u16][subject]}
 */
export function decodeQueryUpdate(
  data: Uint8Array,
): DecodedQueryUpdate | undefined {
  let pos = 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const readStr = (): string | undefined => {
    if (pos + 2 > data.length) return undefined;
    const len = view.getUint16(pos, false);
    pos += 2;
    if (pos + len > data.length) return undefined;
    const s = decoder.decode(data.subarray(pos, pos + len));
    pos += len;

    return s;
  };

  const property = readStr();
  const value = readStr();

  if (property === undefined || value === undefined) return undefined;

  if (pos + 2 > data.length) return undefined;
  const addedCount = view.getUint16(pos, false);
  pos += 2;
  const added: string[] = [];

  for (let i = 0; i < addedCount; i++) {
    const s = readStr();
    if (s === undefined) return undefined;
    added.push(s);
  }

  if (pos + 2 > data.length) return undefined;
  const removedCount = view.getUint16(pos, false);
  pos += 2;
  const removed: string[] = [];

  for (let i = 0; i < removedCount; i++) {
    const s = readStr();
    if (s === undefined) return undefined;
    removed.push(s);
  }

  return {
    property: property === '' ? undefined : property,
    value: value === '' ? undefined : value,
    added,
    removed,
  };
}

// ---- Debug logging ----

const TAG_NAMES: Record<number, string> = {
  [Tag.AUTH]: 'AUTH',
  [Tag.AUTH_OK]: 'AUTH_OK',
  [Tag.ERROR]: 'ERROR',
  [Tag.GET]: 'GET',
  [Tag.UPDATE]: 'UPDATE',
  [Tag.DESTROY]: 'DESTROY',
  [Tag.COMMIT]: 'COMMIT',
  [Tag.COMMIT_OK]: 'COMMIT_OK',
  [Tag.SUB]: 'SUB',
  [Tag.UNSUB]: 'UNSUB',
  [Tag.SYNC]: 'SYNC',
  [Tag.SYNC_OK]: 'SYNC_OK',
  [Tag.SYNC_DIFF]: 'SYNC_DIFF',
  [Tag.SYNC_PUSH]: 'SYNC_PUSH',
  [Tag.QUERY_UPDATE]: 'QUERY_UPDATE',
  [Tag.BLOB_REQUEST]: 'BLOB_REQUEST',
  [Tag.BLOB_RESPONSE]: 'BLOB_RESPONSE',
  [Tag.EPHEMERAL]: 'EPHEMERAL',
};

/**
 * Format bytes to kb for debug headlines. e.g. `128 -> "0.13kb"`, `2048 -> "2kb"`.
 */
function formatBytes(n: number): string {
  const kb = n / 1024;
  if (kb === 0) return '0kb';
  const formatted = kb < 0.1 ? kb.toFixed(3) : (kb < 10 ? kb.toFixed(2) : kb.toFixed(1));
  return `${formatted.replace(/\.?0+$/, '')}kb`;
}

/**
 * Decoded payload for an inspectable frame. The `details` field is meant for
 * `console.debug`-level inspection (browsers hide debug logs unless the
 * "Verbose" log level is enabled, so this is opt-in noise).
 *
 * Lazy: `details` is a getter so we only pay the decode cost (e.g. building
 * a Resource from a loro snapshot) when the user actually expands the group.
 */
export interface FrameDebugInfo {
  headline: string;
  details?: () => unknown;
}

/**
 * Like {@link debugFrame} but returns both a headline and a lazy `details`
 * function for inspecting the frame's payload contents (subject, decoded
 * fields, snapshot byte length, etc.). UPDATE frames also expose the raw
 * loro snapshot bytes so callers that want to materialize the resource
 * (e.g. to show the contained propvals) can do so without re-decoding.
 */
export function debugFrameInfo(
  data: Uint8Array,
  direction: '→' | '←',
): FrameDebugInfo {
  if (data.length === 0) return { headline: `${direction} (empty)` };

  const tag = data[0];
  const name = TAG_NAMES[tag] ?? `0x${tag.toString(16)}`;
  const payload = data.subarray(1);

  switch (tag) {
    case Tag.AUTH:
      return {
        headline: `${direction} AUTH (${formatBytes(payload.length)})`,
        details: () => ({ payloadBytes: payload.length }),
      };

    case Tag.AUTH_OK:
      return { headline: `${direction} AUTH_OK` };

    case Tag.ERROR: {
      const msg = decodeError(payload);

      return {
        headline: msg
          ? `${direction} ERROR #${msg.requestId}: ${msg.message}`
          : `${direction} ERROR (${formatBytes(payload.length)})`,
        details: () => msg ?? { rawBytes: payload.length },
      };
    }

    case Tag.GET: {
      const msg = decodeGet(payload);

      return {
        headline: msg
          ? `${direction} GET #${msg.requestId} ${msg.subject}`
          : `${direction} GET (${formatBytes(payload.length)})`,
        details: () => msg ?? { rawBytes: payload.length },
      };
    }

    case Tag.COMMIT:

    case Tag.COMMIT_OK: {
      const msg = decodeCommit(payload);

      return {
        headline: msg
          ? `${direction} ${name} #${msg.requestId} (${formatBytes(msg.commitJson.length)})`
          : `${direction} ${name} (${formatBytes(payload.length)})`,
        details: () => msg ?? { rawBytes: payload.length },
      };
    }

    case Tag.UPDATE: {
      const msg = decodeUpdate(payload);

      if (!msg) {
        return {
          headline: `${direction} UPDATE (${formatBytes(payload.length)})`,
          details: () => ({ rawBytes: payload.length }),
        };
      }

      const flags: string[] = [];

      if (msg.flags & Flags.SNAPSHOT) flags.push('snapshot');
      if (msg.flags & Flags.PUSH) flags.push('push');
      if (msg.commitId) flags.push(`commit=${msg.commitId.slice(0, 20)}…`);

      return {
        headline: `${direction} UPDATE ${msg.subject} [${flags.join(', ')}] (${formatBytes(msg.loroBytes.length)})`,
        details: () => ({
          subject: msg.subject,
          flags: msg.flags,
          flagNames: flags,
          commitId: msg.commitId,
          loroBytes: msg.loroBytes.length,
          loroSnapshot: msg.loroBytes,
        }),
      };
    }

    case Tag.DESTROY: {
      const subject = decoder.decode(payload.subarray(2));

      return {
        headline: `${direction} DESTROY ${subject}`,
        details: () => ({ subject }),
      };
    }

    case Tag.SUB:

    case Tag.UNSUB: {
      const subject = decoder.decode(payload);

      return {
        headline: `${direction} ${name} ${subject}`,
        details: () => ({ subject }),
      };
    }

    case Tag.SYNC_OK: {
      const msg = decodeSyncOk(payload);

      return {
        headline: `${direction} SYNC_OK ${msg?.drive ?? ''}`,
        details: () => msg ?? { rawBytes: payload.length },
      };
    }

    case Tag.SYNC_DIFF: {
      const msg = decodeSyncDiff(payload);

      return {
        headline: msg
          ? `${direction} SYNC_DIFF ${msg.drive} (pull=${msg.pull.length}, push=${msg.push.length})`
          : `${direction} SYNC_DIFF (${formatBytes(payload.length)})`,
        details: () => msg ?? { rawBytes: payload.length },
      };
    }

    case Tag.SYNC_PUSH: {
      const msg = decodeSyncPush(payload);

      return {
        headline: msg
          ? `${direction} SYNC_PUSH ${msg.drive} (${msg.entries.length} resources${msg.last ? ', last' : ''}, ${formatBytes(payload.length)})`
          : `${direction} SYNC_PUSH (${formatBytes(payload.length)})`,
        details: () => msg ?? { rawBytes: payload.length },
      };
    }

    case Tag.BLOB_REQUEST:
      return {
        headline: `${direction} BLOB_REQUEST (${formatBytes(payload.length)})`,
        details: () => ({ rawBytes: payload.length }),
      };

    case Tag.BLOB_RESPONSE:
      return {
        headline: `${direction} BLOB_RESPONSE (${formatBytes(payload.length)})`,
        details: () => ({ rawBytes: payload.length }),
      };

    default:
      return {
        headline: `${direction} ${name} (${formatBytes(payload.length)})`,
        details: () => ({ tag, rawBytes: payload.length }),
      };
  }
}

/** Produce a human-readable summary of a binary frame for debugging. */
export function debugFrame(data: Uint8Array, direction: '→' | '←'): string {
  if (data.length === 0) return `${direction} (empty)`;

  const tag = data[0];
  const name = TAG_NAMES[tag] ?? `0x${tag.toString(16)}`;
  const payload = data.subarray(1);

  switch (tag) {
    case Tag.AUTH:
      return `${direction} AUTH (${formatBytes(payload.length)})`;

    case Tag.AUTH_OK:
      return `${direction} AUTH_OK`;

    case Tag.ERROR: {
      const msg = decodeError(payload);

      return msg
        ? `${direction} ERROR #${msg.requestId}: ${msg.message}`
        : `${direction} ERROR (${formatBytes(payload.length)})`;
    }

    case Tag.GET: {
      const msg = decodeGet(payload);

      return msg
        ? `${direction} GET #${msg.requestId} ${msg.subject}`
        : `${direction} GET (${formatBytes(payload.length)})`;
    }

    case Tag.COMMIT:

    case Tag.COMMIT_OK: {
      const msg = decodeCommit(payload);

      return msg
        ? `${direction} ${name} #${msg.requestId} (${formatBytes(msg.commitJson.length)})`
        : `${direction} ${name} (${formatBytes(payload.length)})`;
    }

    case Tag.UPDATE: {
      const msg = decodeUpdate(payload);

      if (!msg) return `${direction} UPDATE (${formatBytes(payload.length)})`;

      const flags = [];

      if (msg.flags & Flags.SNAPSHOT) flags.push('snapshot');
      if (msg.flags & Flags.PUSH) flags.push('push');
      if (msg.commitId) flags.push(`commit=${msg.commitId.slice(0, 20)}…`);

      return `${direction} UPDATE ${msg.subject} [${flags.join(', ')}] (${formatBytes(msg.loroBytes.length)})`;
    }

    case Tag.DESTROY:
      return `${direction} DESTROY ${decoder.decode(payload.subarray(2))}`;

    case Tag.SUB:
    case Tag.UNSUB:
      return `${direction} ${name} ${decoder.decode(payload)}`;

    case Tag.SYNC_OK: {
      const msg = decodeSyncOk(payload);

      return `${direction} SYNC_OK ${msg?.drive ?? ''}`;
    }

    case Tag.SYNC_DIFF: {
      const msg = decodeSyncDiff(payload);

      return msg
        ? `${direction} SYNC_DIFF ${msg.drive} (pull=${msg.pull.length}, push=${msg.push.length})`
        : `${direction} SYNC_DIFF (${formatBytes(payload.length)})`;
    }

    case Tag.SYNC_PUSH: {
      const msg = decodeSyncPush(payload);

      return msg
        ? `${direction} SYNC_PUSH ${msg.drive} (${msg.entries.length} resources${msg.last ? ', last' : ''}, ${formatBytes(payload.length)})`
        : `${direction} SYNC_PUSH (${formatBytes(payload.length)})`;
    }

    case Tag.BLOB_REQUEST:
      return `${direction} BLOB_REQUEST (${formatBytes(payload.length)})`;

    case Tag.BLOB_RESPONSE:
      return `${direction} BLOB_RESPONSE (${formatBytes(payload.length)})`;

    default:
      return `${direction} ${name} (${formatBytes(payload.length)})`;
  }
}
