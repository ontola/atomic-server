import { describe, expect, it } from 'vitest';
import { proxyTrafficHost } from './proxyTrafficHost';

describe('proxyTrafficHost', () => {
  it('names atomic.place for the apex domain', () => {
    expect(proxyTrafficHost('https://atomic.place')).toBe('atomic.place');
  });

  it('names atomic.place for any subdomain', () => {
    expect(proxyTrafficHost('https://integrations.atomic.place')).toBe(
      'atomic.place',
    );
    expect(proxyTrafficHost('https://a.b.atomic.place')).toBe('atomic.place');
    expect(proxyTrafficHost('https://Integrations.Atomic.Place')).toBe(
      'atomic.place',
    );
  });

  it('does not mistake a lookalike for atomic.place', () => {
    expect(proxyTrafficHost('https://evilatomic.place')).toBe(
      'evilatomic.place',
    );
    expect(proxyTrafficHost('https://atomic.place.example.com')).toBe(
      'atomic.place.example.com',
    );
  });

  it('names any other host itself', () => {
    expect(proxyTrafficHost('https://localthought.io')).toBe('localthought.io');
    expect(proxyTrafficHost('https://proxy.example.org')).toBe(
      'proxy.example.org',
    );
  });

  it('keeps a port so a local proxy is identifiable', () => {
    expect(proxyTrafficHost('http://localhost:8787')).toBe('localhost:8787');
  });

  it('returns the input when it is not a URL', () => {
    expect(proxyTrafficHost('not a url')).toBe('not a url');
  });
});
