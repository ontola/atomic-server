import { describe, expect, it } from 'vitest';
import { sharedAppUrl } from './sharedApp';

const at = (url: string) => {
  const u = new URL(url);

  return {
    origin: u.origin,
    hostname: u.hostname,
    protocol: u.protocol,
    pathname: u.pathname,
    search: u.search,
    hash: u.hash,
  };
};

describe('sharedAppUrl', () => {
  it('sends a node origin to the portal’s app host, keeping the node as hint', () => {
    expect(
      sharedAppUrl(
        at('https://node1.atomicserver.eu/app/sync'),
        'https://atomic.place',
      ),
    ).toBe(
      'https://app.atomic.place/app/sync?server=https%3A%2F%2Fnode1.atomicserver.eu',
    );
  });

  it('keeps an existing server hint and the hash', () => {
    expect(
      sharedAppUrl(
        at(
          'https://node1.atomicserver.eu/app/show?server=https%3A%2F%2Fx.test#a',
        ),
        'https://atomic.place/',
      ),
    ).toBe('https://app.atomic.place/app/show?server=https%3A%2F%2Fx.test#a');
  });

  it('does nothing on the portal’s own site', () => {
    expect(
      sharedAppUrl(
        at('https://app.atomic.place/app/sync'),
        'https://atomic.place',
      ),
    ).toBeUndefined();
    expect(
      sharedAppUrl(
        at('https://node1.atomic.place/app/sync'),
        'https://atomic.place',
      ),
    ).toBeUndefined();
  });

  it('does nothing without a portal or on plain http', () => {
    expect(
      sharedAppUrl(at('https://node1.atomicserver.eu/'), null),
    ).toBeUndefined();
    expect(
      sharedAppUrl(
        at('http://localhost:9883/app/sync'),
        'https://atomic.place',
      ),
    ).toBeUndefined();
  });
});
