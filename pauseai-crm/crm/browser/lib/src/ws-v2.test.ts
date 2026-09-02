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
