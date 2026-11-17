import { describe, expect, it } from 'vitest';
import { syncablesProxyUrl } from './syncablesProxyScope';

const scope = {
  proxyOrigin: 'https://proxy.example',
  platform: 'github-issues',
  kind: 'mirror',
  connectionId: 'my-connection',
  repoId: '456',
};

describe('built-in Syncables proxy scope', () => {
  it('builds the selected source URL from the saved repository and connection IDs', () => {
    expect(syncablesProxyUrl(scope, 'issues', 2).href).toBe(
      'https://proxy.example/proxy/my-connection/github-issues/repositories/456/issues?per_page=100&page=2&state=all',
    );
  });

  it('refuses unrelated endpoints, invalid page numbers and invalid bindings', () => {
    expect(() => syncablesProxyUrl(scope, 'repositories')).toThrow();
    expect(() =>
      syncablesProxyUrl(scope, 'https://elsewhere.example'),
    ).toThrow();
    expect(() => syncablesProxyUrl(scope, 'issues', 21)).toThrow();
    expect(() => syncablesProxyUrl(scope, 'issues', '2')).toThrow();
    expect(() =>
      syncablesProxyUrl({ ...scope, repoId: '../456' }, 'issues'),
    ).toThrow();
  });

  it('exposes independently authorized listing and profile reads', () => {
    expect(
      syncablesProxyUrl({ ...scope, kind: 'organizations' }, 'owners').pathname,
    ).toBe('/proxy/my-connection/github-issues/user/orgs');
    expect(
      syncablesProxyUrl({ ...scope, kind: 'platform' }, 'profile').pathname,
    ).toBe('/proxy/my-connection/github-issues/user');
    expect(() =>
      syncablesProxyUrl({ ...scope, kind: 'repositories' }, 'owners'),
    ).toThrow();
  });
});
