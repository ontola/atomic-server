import { describe, it } from 'vitest';
import { Agent } from './agent.js';
import { encodeB64 } from './base64.js';

/**
 * The determinism tests elsewhere build their Agent from `JSCryptoProvider`.
 * The app does not: in a secure context it stores a non-extractable
 * `CryptoKey` and signs through `SubtleCryptoProvider`. A derived subject that
 * is stable under one provider and not the other would look correct in CI and
 * mint a fresh personal drive on every sign-in in the product, so the guarantee
 * is only worth as much as its coverage of the provider actually used.
 */
describe('derived personal drive under SubtleCrypto', () => {
  const secretFor = async () => {
    const keys = await Agent.generateKeyPair();

    return encodeB64(
      new TextEncoder().encode(
        JSON.stringify({
          privateKey: keys.privateKey,
          subject: 'did:ad:agent:test',
        }),
      ),
    );
  };

  it('is stable across two Agents built from the same secret', async ({
    expect,
  }) => {
    const secret = await secretFor();

    const a = await Agent.fromSecret(secret);
    const b = await Agent.fromSecret(secret);

    const first = await a.personalDriveSubject();
    const second = await b.personalDriveSubject();

    expect(first).toBe(second);
  });

  it('is stable across repeated calls on one Agent', async ({ expect }) => {
    const agent = await Agent.fromSecret(await secretFor());

    const first = await agent.personalDriveSubject();
    const second = await agent.personalDriveSubject();

    expect(first).toBe(second);
  });

  it('agrees with the JS provider for the same key', async ({ expect }) => {
    const secret = await secretFor();

    const subtle = await Agent.fromSecret(secret);
    const js = Agent.fromSecret(secret, 'js');

    expect(await subtle.personalDriveSubject()).toBe(
      await js.personalDriveSubject(),
    );
  });
});
