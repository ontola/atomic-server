import { describe, it } from 'vitest';
import { decodeError, ErrorCode, Tag } from './ws-v2.js';

function frame(requestId: number, code: number, message: string): Uint8Array {
  const messageBytes = new TextEncoder().encode(message);
  const buf = new Uint8Array(5 + messageBytes.length);
  buf[0] = Tag.ERROR;
  buf[1] = (requestId >> 8) & 0xff;
  buf[2] = requestId & 0xff;
  buf[3] = (code >> 8) & 0xff;
  buf[4] = code & 0xff;
  buf.set(messageBytes, 5);

  return buf;
}

describe('decodeError (F5: planning/unified-sync.md)', () => {
  it('decodes requestId, code, and message', ({ expect }) => {
    const encoded = frame(42, ErrorCode.UNAUTHORIZED_WRITE, 'No write right');
    // decodeError receives the payload AFTER the tag byte, matching how
    // `handleBinary` slices frames in websockets.ts.
    const decoded = decodeError(encoded.subarray(1));

    expect(decoded).toEqual({
      requestId: 42,
      code: ErrorCode.UNAUTHORIZED_WRITE,
      message: 'No write right',
    });
  });

  it('decodes an UNKNOWN code the same way as any other', ({ expect }) => {
    const encoded = frame(1, ErrorCode.UNKNOWN, 'Invalid GET frame');
    const decoded = decodeError(encoded.subarray(1));

    expect(decoded?.code).toBe(ErrorCode.UNKNOWN);
    expect(decoded?.message).toBe('Invalid GET frame');
  });

  it('returns undefined for a too-short payload', ({ expect }) => {
    // Below the [requestId: u16][code: u16] minimum (4 bytes).
    expect(decodeError(new Uint8Array([0, 1, 0]))).toBeUndefined();
  });
});

// ---- Cross-implementation golden vectors ----
//
// `lib/src/sync/protocol_vectors.json` is written by the Rust codec
// (`cargo test -p atomic_lib print_wire_vectors -- --ignored --nocapture`).
// Every frame this codec can encode must come out byte-identical; every
// frame it decodes must yield the recorded fields. A failure here means the
// two implementations drifted: fix the codec, or regenerate the vectors
// deliberately and update `docs/src/websockets.md` in the same change.

import { readFileSync } from 'node:fs';
import {
  decodeAuthOk,
  decodeCommit,
  decodeGet,
  decodeSubject,
  decodeSyncDiff,
  decodeSyncOk,
  decodeSyncPush,
  decodeUpdate,
  decodeBlobRequest,
  decodeBlobResponse,
  encodeBlobRequest,
  encodeBlobResponse,
  encodeCommit,
  encodeGet,
  encodeKeepalive,
  encodeSub,
  encodeSync,
  encodeSyncPush,
  encodeUnsub,
  Flags,
} from './ws-v2.js';

const vectors: Record<string, Uint8Array> = Object.fromEntries(
  (
    JSON.parse(
      readFileSync(
        new URL('../../../lib/src/sync/protocol_vectors.json', import.meta.url),
        'utf8',
      ),
    ).vectors as Array<{ name: string; hex: string }>
  ).map(v => [v.name, hexToBytes(v.hex)]),
);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);

  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

const payload = (name: string) => vectors[name].subarray(1);

describe('wire vectors shared with lib/src/sync/protocol.rs', () => {
  it('has the frames this codec is tested against', ({ expect }) => {
    for (const name of [
      'auth_ok_caps',
      'error',
      'get',
      'update_delta_push',
      'destroy',
      'commit',
      'commit_ok',
      'sub',
      'unsub',
      'sync',
      'sync_ok',
      'sync_diff',
      'sync_push_last',
      'blob_request',
      'blob_response',
      'keepalive',
    ]) {
      expect(vectors[name], name).toBeDefined();
    }
  });

  it('encodes byte-identically to Rust', ({ expect }) => {
    expect(toHex(encodeGet(1, 'did:ad:x'))).toBe(toHex(vectors.get));
    expect(toHex(encodeCommit(9, '{"a":1}'))).toBe(toHex(vectors.commit));
    expect(toHex(encodeSub('did:ad:d'))).toBe(toHex(vectors.sub));
    expect(toHex(encodeUnsub('did:ad:d'))).toBe(toHex(vectors.unsub));
    expect(toHex(encodeKeepalive())).toBe(toHex(vectors.keepalive));
    expect(toHex(encodeBlobRequest(new Uint8Array(32).fill(0xab)))).toBe(
      toHex(vectors.blob_request),
    );
    expect(
      toHex(
        encodeBlobResponse(
          new Uint8Array(32).fill(0xab),
          new Uint8Array([9, 9]),
        ),
      ),
    ).toBe(toHex(vectors.blob_response));
    expect(
      toHex(
        encodeSyncPush(
          'did:ad:d',
          [{ subject: 'did:ad:x', loroBytes: new Uint8Array([1, 2]) }],
          true,
        ),
      ),
    ).toBe(toHex(vectors.sync_push_last));
  });

  it('encodes SYNC with the length-prefixed hex hash Rust decodes', ({
    expect,
  }) => {
    // The JSON tail is whatever Rust serialised; take it from the vector so
    // this pins the framing (drive, hash_len, hash) and not key ordering.
    const syncFrame = vectors.sync;
    const driveLen = (syncFrame[1] << 8) | syncFrame[2];
    const hashOff = 3 + driveLen;
    const hashLen = (syncFrame[hashOff] << 8) | syncFrame[hashOff + 1];
    const jsonOff = hashOff + 2 + hashLen;
    const vvJson = new TextDecoder().decode(syncFrame.subarray(jsonOff));

    expect(new TextDecoder().decode(syncFrame.subarray(3, 3 + driveLen))).toBe(
      'did:ad:d',
    );
    expect(
      new TextDecoder().decode(syncFrame.subarray(hashOff + 2, jsonOff)),
    ).toBe('abc123');
    expect(toHex(encodeSync('did:ad:d', 'abc123', vvJson))).toBe(
      toHex(syncFrame),
    );
  });

  it('decodes the recorded frames', ({ expect }) => {
    expect(decodeAuthOk(payload('auth_ok_caps'))).toEqual([
      'keepalive',
      'unsub',
    ]);
    expect(decodeAuthOk(payload('auth_ok_bare'))).toEqual([]);

    expect(decodeError(payload('error'))).toEqual({
      requestId: 7,
      code: ErrorCode.UNAUTHORIZED_READ,
      message: 'SUB refused for did:ad:d: no',
    });

    expect(decodeGet(payload('get'))).toEqual({
      requestId: 1,
      subject: 'did:ad:x',
    });

    const update = decodeUpdate(payload('update_delta_push'));
    expect(update?.flags).toBe(Flags.HAS_COMMIT_ID | Flags.PUSH);
    expect(update?.subject).toBe('did:ad:x');
    expect(update?.commitId).toBe('did:ad:commit:abc');
    expect([...(update?.loroBytes ?? [])]).toEqual([1, 2, 3]);

    const snapshot = decodeUpdate(payload('update_snapshot'));
    expect(snapshot?.flags).toBe(Flags.SNAPSHOT);
    expect(snapshot?.requestId).toBe(5);
    expect(snapshot?.commitId).toBeUndefined();

    // DESTROY: [request_id: u16] [subject]; `handleBinary` skips the id.
    expect(decodeSubject(payload('destroy').subarray(2))).toBe('did:ad:x');

    expect(decodeCommit(payload('commit_ok'))).toEqual({
      requestId: 9,
      commitJson: '{"a":1}',
    });

    expect(decodeSyncOk(payload('sync_ok'))).toEqual({ drive: 'did:ad:d' });

    expect(decodeSyncDiff(payload('sync_diff'))).toEqual({
      drive: 'did:ad:d',
      pull: ['did:ad:y'],
      push: ['did:ad:x'],
      remove: ['did:ad:z'],
      pullFrom: { 'did:ad:y': { p1: 2 } },
    });

    const push = decodeSyncPush(payload('sync_push_last'));
    expect(push?.drive).toBe('did:ad:d');
    expect(push?.last).toBe(true);
    expect(push?.entries.map(e => e.subject)).toEqual(['did:ad:x']);

    expect([...(decodeBlobRequest(payload('blob_request')) ?? [])]).toEqual(
      new Array(32).fill(0xab),
    );
    const blob = decodeBlobResponse(payload('blob_response'));
    expect([...(blob?.bytes ?? [])]).toEqual([9, 9]);
  });
});
