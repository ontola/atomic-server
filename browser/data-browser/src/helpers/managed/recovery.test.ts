import { describe, it, expect, vi, afterEach } from 'vitest';
import { passkeyRpId, secretAccountConflict } from './recovery';

/**
 * The RP ID a recovery passkey is created and asserted under.
 *
 * Getting this wrong does not fail loudly — a mismatched rpId means the
 * authenticator simply reports no matching credential, which surfaces as "no
 * passkey was provided" rather than as a configuration error. Hence the table.
 */
describe('passkeyRpId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Vitest runs in the node environment here, so there is no window to patch. */
  function inBrowserAt(hostname: string, { tauri = false } = {}) {
    vi.stubGlobal('window', {
      location: {
        hostname,
        protocol: tauri ? 'tauri:' : 'https:',
      },
      ...(tauri ? { __TAURI_INTERNALS__: {} } : {}),
    });
  }

  it('uses the parent domain on the portal', () => {
    inBrowserAt('atomicserver.eu');
    expect(passkeyRpId()).toBe('atomicserver.eu');
  });

  it('uses the parent domain on the app host, not the app host itself', () => {
    inBrowserAt('app.atomicserver.eu');
    expect(passkeyRpId()).toBe('atomicserver.eu');
  });

  // `endsWith('.atomicserver.eu')` and not `endsWith('atomicserver.eu')`: the
  // leading dot is what stops an attacker-registered lookalike from claiming
  // our RP. Without it this returns our RP ID on a domain we do not control.
  it('does not treat a lookalike domain as ours', () => {
    inBrowserAt('evilatomicserver.eu');
    expect(passkeyRpId()).toBeUndefined();
  });

  it('defaults to the origin during local dev', () => {
    // rp.id must be a suffix of the origin's domain, so naming a real domain
    // on localhost throws SecurityError — undefined is the only legal answer.
    inBrowserAt('localhost');
    expect(passkeyRpId()).toBeUndefined();
  });

  // The Tauri webview's hostname is also literally "localhost", so this case
  // is indistinguishable from the one above by hostname alone. It is the whole
  // reason the Tauri check exists, and the reason it must come second.
  it('names the RP explicitly in the Tauri app, despite the localhost host', () => {
    inBrowserAt('localhost', { tauri: true });
    expect(passkeyRpId()).toBe('atomicserver.eu');
  });

  it('is undefined when there is no window at all', () => {
    vi.stubGlobal('window', undefined);
    expect(passkeyRpId()).toBeUndefined();
  });
});

describe('secretAccountConflict', () => {
  const key = 'A7x4uVX5c0bGmCAX2Lr13sB8pH7gcDYHfJk9R0Wn3lE';
  const account = {
    owner_email: 'joep@ontola.io',
    agent_subject: `did:ad:agent:${key}`,
  };

  it('is no conflict when the secret opens the account agent', () => {
    expect(secretAccountConflict(account, `atomic:agent:${key}`)).toBeNull();
  });

  it('is no conflict when nobody is signed in', () => {
    expect(secretAccountConflict(null, 'atomic:agent:other')).toBeNull();
  });

  it('names both agents and the account when they differ', () => {
    expect(secretAccountConflict(account, 'atomic:agent:other')).toEqual({
      email: 'joep@ontola.io',
      accountAgent: `did:ad:agent:${key}`,
      secretAgent: 'atomic:agent:other',
    });
  });
});
