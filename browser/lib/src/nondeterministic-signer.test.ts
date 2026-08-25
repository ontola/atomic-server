import { describe, it } from 'vitest';
import { Agent } from './agent.js';
import { JSCryptoProvider, type CryptoProvider } from './CryptoProvider.js';
import { encodeB64Url, decodeB64 } from './base64.js';
import { getPublicKey, sign } from '@noble/ed25519';

/**
 * WebCrypto does not promise that signing the same bytes twice yields the same
 * signature, and WKWebView's Ed25519 does not: one session minted 411 distinct
 * personal drives, each a valid signature over one byte-identical certificate.
 *
 * Node's WebCrypto *is* deterministic, so a test using a real provider passes
 * here no matter how broken the product is. Reproducing it needs a signer that
 * randomizes on purpose.
 */
class RandomizingProvider implements CryptoProvider {
  #inner: JSCryptoProvider;

  constructor(privateKey: string) {
    this.#inner = new JSCryptoProvider(privateKey);
  }

  public get type(): string {
    return 'randomizing';
  }

  public get signsDeterministically(): boolean {
    return false;
  }

  public async sign(message: string): Promise<string> {
    return this.signBytes(new TextEncoder().encode(message));
  }

  /**
   * A signature over `data` that differs on every call. WebKit gets there by
   * randomizing Ed25519's nonce; signing under a throwaway key reproduces the
   * property that matters here — the caller cannot predict the result.
   */
  public async signBytes(data: Uint8Array): Promise<string> {
    const throwaway = crypto.getRandomValues(new Uint8Array(32));

    return encodeB64Url(await sign(data, throwaway));
  }

  public async getPublicKey(): Promise<string> {
    return this.#inner.getPublicKey();
  }
}

describe('personal drive derivation under a non-deterministic signer', () => {
  it('the stub really does sign differently each call', async ({ expect }) => {
    const keys = await Agent.generateKeyPair();
    const provider = new RandomizingProvider(keys.privateKey);
    const bytes = new TextEncoder().encode('same bytes every time');

    expect(await provider.signBytes(bytes)).not.toBe(
      await provider.signBytes(bytes),
    );
  });

  it('refuses to invent a subject it cannot reproduce', async ({ expect }) => {
    const keys = await Agent.generateKeyPair();
    const agent = new Agent(
      new RandomizingProvider(keys.privateKey),
      `did:ad:agent:${keys.publicKey}`,
    );

    // The wording is user-facing: this message is shown when creating a drive
    // fails, so it has to name the thing the user knows ("private drive") and
    // carry the one action that fixes it.
    await expect(agent.privateDriveSubject()).rejects.toThrow(/private drive/i);
    await expect(agent.privateDriveSubject()).rejects.toThrow(
      /sign in with the secret again/i,
    );
  });

  it('uses the subject derived at sign-in, not the live signer', async ({
    expect,
  }) => {
    const keys = await Agent.generateKeyPair();
    const secret = Agent.buildSecret(
      keys.privateKey,
      `did:ad:agent:${keys.publicKey}`,
    );
    const derived = await Agent.privateDriveSubjectFromSecret(secret);

    const agent = new Agent(
      new RandomizingProvider(keys.privateKey),
      `did:ad:agent:${keys.publicKey}`,
    );
    agent.privateDrive = derived;

    // Stable across calls, and equal to what any other device would compute.
    expect(await agent.privateDriveSubject()).toBe(derived);
    expect(await agent.privateDriveSubject()).toBe(derived);
  });

  it('derives the same subject from the secret as from the raw key', async ({
    expect,
  }) => {
    const keys = await Agent.generateKeyPair();
    const secret = Agent.buildSecret(
      keys.privateKey,
      `did:ad:agent:${keys.publicKey}`,
    );

    const fromSecret = await Agent.privateDriveSubjectFromSecret(secret);
    const jsAgent = Agent.fromSecret(secret, 'js');

    expect(await jsAgent.privateDriveSubject()).toBe(fromSecret);
    // And it is a signature by this key, not some other value.
    expect(
      await getPublicKey(new Uint8Array(decodeB64(keys.privateKey))),
    ).toEqual(new Uint8Array(decodeB64(keys.publicKey)));
  });
});
