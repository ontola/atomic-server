import { describe, it, expect } from 'vitest';
import { parentDomainsOf } from './authentication.js';

describe('parentDomainsOf', () => {
  it('lists the host and every parent, excluding the TLD', () => {
    // The host itself is included on purpose: `Domain=atomicdata.dev` is a
    // different cookie entry from the host-only one, and on the apex host it
    // is the entry that leaks down into subdomains.
    // The TLD is excluded because browsers reject `Domain=dev` outright.
    expect(parentDomainsOf('staging.atomicdata.dev')).toEqual([
      'staging.atomicdata.dev',
      'atomicdata.dev',
    ]);
  });

  it('includes the apex itself, so production can clear its own wide cookie', () => {
    expect(parentDomainsOf('atomicdata.dev')).toContain('atomicdata.dev');
  });

  it('handles a bare apex domain', () => {
    expect(parentDomainsOf('atomicdata.dev')).toEqual(['atomicdata.dev']);
  });

  it('walks several levels of subdomain', () => {
    expect(parentDomainsOf('a.b.example.com')).toEqual([
      'a.b.example.com',
      'b.example.com',
      'example.com',
    ]);
  });

  it('does not produce a bare TLD to clear', () => {
    // `Domain=dev` would be rejected by the browser, and naming it would be a
    // request to clear a cookie for every .dev site.
    for (const host of ['atomicdata.dev', 'staging.atomicdata.dev']) {
      expect(parentDomainsOf(host)).not.toContain('dev');
    }
  });

  it('leaves localhost alone', () => {
    // Nothing to widen to, so nothing to clear beyond the host itself.
    expect(parentDomainsOf('localhost')).toEqual([]);
  });
});

// Runtime guard for the shape `createAuthentication` returns.
//
// atomic-saas's `portal/src/enrollmentProof.ts` reads three of these fields
// straight into an `EnrollmentProof` whose `public_key` and `signature` are
// `string` and whose `timestamp` is `number`. Annotating the object here as
// `Record<string, string | number>` typechecks inside this package and breaks
// that build; the declared `AuthenticationResource` return type is what stops
// that now. This test cannot catch a widening on its own -- this package's
// tsconfig excludes `src/**/*.test.ts`, which is why the regression reached
// CI -- so it checks the values instead, and the types above document what
// the downstream consumer needs.
describe('the Authentication resource', () => {
  it('gives each field the type downstream consumers read it as', async () => {
    const { Agent } = await import('./agent.js');
    const { createAuthentication } = await import('./authentication.js');

    const keys = await Agent.generateKeyPair();
    const agent = await Agent.fromSecret(
      Agent.buildSecret(keys.privateKey, `did:ad:agent:${keys.publicKey}`),
      'js',
    );
    const auth = await createAuthentication('https://localhost/thing', agent);

    const publicKey: string =
      auth['https://atomicdata.dev/properties/auth/publicKey'];
    const timestamp: number =
      auth['https://atomicdata.dev/properties/auth/timestamp'];
    const signature: string =
      auth['https://atomicdata.dev/properties/auth/signature'];
    // Optional, so a consumer must be allowed to find it absent.
    const sessionCert: string | undefined =
      auth['https://atomicdata.dev/properties/auth/sessionCert'];

    expect(typeof publicKey).toBe('string');
    expect(typeof timestamp).toBe('number');
    expect(typeof signature).toBe('string');
    expect(sessionCert).toBeUndefined();
  });
});
