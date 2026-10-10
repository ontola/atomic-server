import { describe, expect, it } from 'vitest';
import {
  describeRefusal,
  isRasterImage,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  parseAttachments,
  refuseAttachments,
  safeFileName,
} from './attachments';
import { parsePayload } from './conversationCrypto';

const HASH = 'ab'.repeat(32);
const KEY = 'A'.repeat(43);

const attachment = (overrides: Record<string, unknown> = {}) => ({
  blob: `atomic:blob:${HASH}`,
  key: KEY,
  name: 'holiday.png',
  type: 'image/png',
  size: 1234,
  width: 800,
  height: 600,
  ...overrides,
});

describe('parsePayload', () => {
  it('reads a payload from before attachments existed', () => {
    expect(parsePayload('{"text":"hello"}')).toEqual({
      text: 'hello',
      replyTo: undefined,
      attachments: undefined,
    });
    expect(parsePayload('{"text":"hi","replyTo":"atomic:abc"}')).toEqual({
      text: 'hi',
      replyTo: 'atomic:abc',
      attachments: undefined,
    });
  });

  it('reads a payload with attachments', () => {
    const payload = parsePayload(
      JSON.stringify({ text: '', attachments: [attachment()] }),
    );

    expect(payload?.text).toBe('');
    expect(payload?.attachments).toEqual([attachment()]);
  });

  it('ignores fields it does not know', () => {
    const payload = parsePayload(
      JSON.stringify({
        text: 'x',
        reactions: ['+1'],
        attachments: [{ ...attachment(), colour: 'red' }],
      }),
    );

    expect(payload?.attachments).toEqual([attachment()]);
  });

  it('is null for something that is not a payload', () => {
    expect(parsePayload('not json')).toBeNull();
    expect(parsePayload('{"attachments":[]}')).toBeNull();
    expect(parsePayload('null')).toBeNull();
  });

  it('keeps the text when the attachments make no sense', () => {
    expect(parsePayload('{"text":"hi","attachments":"nope"}')).toEqual({
      text: 'hi',
      replyTo: undefined,
      attachments: undefined,
    });
  });
});

describe('parseAttachments', () => {
  it('skips entries that are not usable instead of failing the rest', () => {
    const parsed = parseAttachments([
      attachment({ blob: 'https://example.com/steal' }),
      attachment({ key: 'short' }),
      attachment({ size: -1 }),
      attachment({ size: 1.5 }),
      attachment({ name: 7 }),
      null,
      'text',
      attachment({ name: 'good.txt', type: 'text/plain' }),
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].name).toBe('good.txt');
  });

  it('defaults a missing type and drops bad dimensions', () => {
    const [parsed] = parseAttachments([
      attachment({ type: undefined, width: -3, height: 'tall' }),
    ])!;

    expect(parsed.type).toBe('');
    expect(parsed.width).toBeUndefined();
    expect(parsed.height).toBeUndefined();
  });

  it('is undefined when nothing is left', () => {
    expect(parseAttachments(undefined)).toBeUndefined();
    expect(parseAttachments([])).toBeUndefined();
    expect(parseAttachments([{}])).toBeUndefined();
  });

  it('never reads more than the cap, whatever a sender put in', () => {
    const many = Array.from({ length: 500 }, () => attachment());

    expect(parseAttachments(many)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
  });
});

describe('refuseAttachments', () => {
  const file = (size: number, name = 'f.bin') => ({ name, size });

  it('accepts files within both limits', () => {
    expect(refuseAttachments([], [file(1), file(MAX_ATTACHMENT_BYTES)])).toBe(
      undefined,
    );
  });

  it('refuses a file over 25 MiB and names it', () => {
    const refusal = refuseAttachments(
      [],
      [file(MAX_ATTACHMENT_BYTES + 1, 'movie.mov')],
    );

    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(refusal).toEqual({
      reason: 'too-large',
      name: 'movie.mov',
      max: MAX_ATTACHMENT_BYTES,
    });
    expect(describeRefusal(refusal!)).toContain('movie.mov');
    expect(describeRefusal(refusal!)).toContain('25 MiB');
  });

  it('allows ten files and refuses the eleventh', () => {
    const ten = Array.from({ length: 10 }, () => file(1));

    expect(refuseAttachments([], ten)).toBe(undefined);
    expect(refuseAttachments(ten.slice(1), [file(1)])).toBe(undefined);
    expect(refuseAttachments(ten, [file(1)])).toEqual({
      reason: 'too-many',
      max: 10,
    });
    expect(refuseAttachments([], [...ten, file(1)])?.reason).toBe('too-many');
  });
});

describe('isRasterImage', () => {
  it('previews only the raster allowlist', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(isRasterImage(type)).toBe(true);
    }

    expect(isRasterImage('IMAGE/PNG')).toBe(true);

    for (const type of [
      'image/svg+xml',
      'text/html',
      'application/pdf',
      'image/png; charset=x',
      '',
    ]) {
      expect(isRasterImage(type)).toBe(false);
    }
  });
});

describe('safeFileName', () => {
  it('removes paths and control characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('a\u0000b\nc.txt')).toBe('a_b_c.txt');
    expect(safeFileName('C:\\Users\\me\\x.exe')).toBe('C__Users_me_x.exe');
  });

  it('falls back to a name when nothing is left', () => {
    expect(safeFileName('')).toBe('attachment');
    expect(safeFileName('...')).toBe('attachment');
  });
});
