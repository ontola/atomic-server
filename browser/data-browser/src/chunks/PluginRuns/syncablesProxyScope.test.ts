import { describe, expect, it } from 'vitest';
import { assertSyncablesProxyRead } from './syncablesProxyScope';

const root = 'https://proxy.example';
const connection = 'conn-123';
const base = `${root}/proxy/${connection}/github-issues`;

describe('built-in Syncables relay scope', () => {
  const organizations = {
    proxyOrigin: root,
    platform: 'github-issues',
    connectionId: connection,
    kind: 'organizations',
  };
  const mirror = {
    ...organizations,
    kind: 'mirror',
    ownerLogin: 'ontola',
    repoName: 'atomic-server',
  };

  it('permits only the declared organization/repository listing', () => {
    expect(() =>
      assertSyncablesProxyRead(organizations, {
        url: `${base}/user/repos?per_page=100&page=1`,
        method: 'GET',
      }),
    ).not.toThrow();
    expect(() =>
      assertSyncablesProxyRead(organizations, {
        url: `${base}/user/orgs`,
        method: 'GET',
      }),
    ).toThrow('only read /user/repos');
  });

  it('permits only issues from the exact selected repository', () => {
    expect(() =>
      assertSyncablesProxyRead(mirror, {
        url: `${base}/repos/ontola/atomic-server/issues?per_page=100&page=1&state=all`,
        method: 'GET',
      }),
    ).not.toThrow();
    for (const url of [
      `${base}/repos/ontola/other-repo/issues`,
      `${base}/repos/another-owner/atomic-server/issues`,
      `${base}/repos/ontola/atomic-server/issues/123`,
      `${root}/proxy/another-connection/github-issues/repos/ontola/atomic-server/issues`,
      `https://evil.example/proxy/${connection}/github-issues/repos/ontola/atomic-server/issues`,
    ]) {
      expect(() => assertSyncablesProxyRead(mirror, { url, method: 'GET' })).toThrow();
    }
  });

  it('rejects writes, unexpected pagination and extra read paths', () => {
    const url = `${base}/repos/ontola/atomic-server/issues`;
    expect(() => assertSyncablesProxyRead(mirror, { url, method: 'POST' })).toThrow('read-only');
    expect(() =>
      assertSyncablesProxyRead(mirror, { url: url + '?since=2020', method: 'GET' }),
    ).toThrow('Unexpected provider query');
    expect(() =>
      assertSyncablesProxyRead(mirror, { url: url + '?page=21', method: 'GET' }),
    ).toThrow('Invalid pagination');
  });
});
