import { describe, expect, it } from 'vitest';
import { acceptFor, readUpload } from './plugin-upload.js';
import type { DeclaredAccept } from './plugin-manifest.js';

const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);

describe('readUpload', () => {
  it('hands a base64 plugin the exact bytes, every value 0–255', () => {
    const upload = readUpload(
      { name: 'drop.willow', type: '' },
      everyByte.buffer,
      { as: 'base64' },
    );

    expect(upload).toEqual({
      name: 'drop.willow',
      mediaType: '',
      size: 256,
      base64: Buffer.from(everyByte).toString('base64'),
    });
    expect('text' in upload).toBe(false);
    expect(
      Uint8Array.from(Buffer.from((upload as { base64: string }).base64, 'base64')),
    ).toEqual(everyByte);
  });

  it('encodes a file larger than one chunk without losing bytes', () => {
    const large = Uint8Array.from({ length: 100_003 }, (_, i) => (i * 7) & 255);
    const upload = readUpload({ name: 'x', type: '' }, large, {
      as: 'base64',
    }) as { base64: string };

    expect(Uint8Array.from(Buffer.from(upload.base64, 'base64'))).toEqual(
      large,
    );
  });

  it('keeps text mode unchanged for MT940, with `as` given or left out', () => {
    const mt940 =
      ':20:STARTUMSE\r\n:25:NL91ABNA0417164300\r\n:28C:00001/001\r\n' +
      ':60F:C240101EUR1000,00\r\n:86:Café\r\n';
    const utf8 = new TextEncoder().encode(mt940);
    // The same statement exported as Windows-1252: é is the single byte 0xE9.
    const cp1252 = Uint8Array.from(mt940, c => c.charCodeAt(0));

    for (const accept of [{ as: 'text' }, {}] as DeclaredAccept[]) {
      for (const bytes of [utf8, cp1252]) {
        const upload = readUpload(
          { name: 'statement.sta', type: 'text/plain' },
          bytes,
          accept,
        );
        expect(upload).toEqual({
          name: 'statement.sta',
          mediaType: 'text/plain',
          size: bytes.byteLength,
          text: mt940,
        });
      }
    }
  });
});

describe('acceptFor', () => {
  const accepts: DeclaredAccept[] = [
    { extensions: ['.sta'], as: 'text' },
    { extensions: ['.willow'], mediaTypes: ['application/x-willow'], as: 'base64' },
  ];

  it('picks the entry that names the file', () => {
    expect(acceptFor({ name: 'A.STA', type: '' }, accepts)).toBe(accepts[0]);
    expect(acceptFor({ name: 'drop.willow', type: '' }, accepts)).toBe(
      accepts[1],
    );
    expect(
      acceptFor({ name: 'drop', type: 'application/x-willow' }, accepts),
    ).toBe(accepts[1]);
  });

  it('falls back to the first entry when none names the file', () => {
    expect(acceptFor({ name: 'other.bin', type: '' }, accepts)).toBe(
      accepts[0],
    );
    expect(acceptFor({ name: 'x', type: '' }, [])).toBeUndefined();
  });
});
