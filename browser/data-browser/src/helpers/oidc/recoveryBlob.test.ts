// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  WrongPassphraseError,
} from './recoveryBlob';

// Few iterations keep the suite fast; the real cost is the module default.
const FAST = 100_000;

describe('recoveryBlob', () => {
  it('round-trips a secret under the right passphrase', async () => {
    const blob = await encryptSecret('the-secret', 'correct horse', FAST);

    expect(blob.startsWith('v1.100000.')).toBe(true);
    expect(blob).not.toContain('the-secret');
    expect(await decryptSecret(blob, 'correct horse')).toBe('the-secret');
  });

  it('refuses a wrong passphrase', async () => {
    const blob = await encryptSecret('the-secret', 'correct horse', FAST);

    await expect(decryptSecret(blob, 'wrong horse')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it('uses a fresh salt and iv every time', async () => {
    const a = await encryptSecret('s', 'passphrase!!', FAST);
    const b = await encryptSecret('s', 'passphrase!!', FAST);

    expect(a).not.toBe(b);
  });

  it('refuses tampered or hostile blobs without deriving a key', async () => {
    const blob = await encryptSecret('s', 'passphrase!!', FAST);
    const parts = blob.split('.');
    const tampered = [...parts.slice(0, 4), `${parts[4]}AA`].join('.');

    await expect(
      decryptSecret(tampered, 'passphrase!!'),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
    // A server cannot make the browser grind for minutes.
    parts[1] = '999999999999';
    await expect(decryptSecret(parts.join('.'), 'x')).rejects.toThrow(
      /not valid/,
    );
    await expect(decryptSecret('garbage', 'x')).rejects.toThrow(/not valid/);
  });
});
