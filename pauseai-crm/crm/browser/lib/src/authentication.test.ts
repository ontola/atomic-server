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
