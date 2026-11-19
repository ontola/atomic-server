import { describe, expect, it } from 'vitest';
import {
  isSyncablesNavigationTable,
  isSyncablesPlatformRoot,
  withoutTableViews,
} from './syncablesNavigation';

const nodeId = (kind: string, connection?: string) => {
  const key = ['https://proxy.example', 'github-issues', kind, 'remote-id', ''];
  if (connection) key.push(connection);

  return 'syncables:node:' + encodeURIComponent(JSON.stringify(key));
};

it('retains legacy directory recognition without hiding an Accounts resource by local ID', () => {
  expect(isSyncablesNavigationTable('syncables:accounts')).toBe(true);
  expect(isSyncablesNavigationTable('syncables:accounts-extra')).toBe(false);
});

describe('Syncables navigation tables', () => {
  it.each([
    'syncables:platform:https%3A%2F%2Fproxy.example:github-issues',
    // A migrated principal keeps its historical localId while becoming a Table.
    nodeId('account'),
    nodeId('organizations'),
    nodeId('repositories'),
    nodeId('repositories', 'connection-ref'),
    nodeId('public'),
  ])('shows the resource children of %s', localId => {
    expect(isSyncablesNavigationTable(localId)).toBe(true);
  });

  it.each([
    undefined,
    'table1',
    'syncables:platform:',
    'syncables:node:%',
    nodeId('mirror', 'connection-ref'),
    nodeId('public-mirror'),
    nodeId('owner'),
    nodeId('repository'),
  ])('keeps %s out of the navigation table exception', localId => {
    expect(isSyncablesNavigationTable(localId)).toBe(false);
  });

  it('hides only the subjects referenced as table views', () => {
    const account = 'atomic:resource:account';
    const userTable = 'atomic:resource:user-table';
    const tableView = 'atomic:resource:table-view';
    const syncView = 'atomic:resource:sync-view';

    expect(
      withoutTableViews(
        [tableView, account, syncView, userTable],
        ['did:ad:resource:table-view', syncView],
      ),
    ).toEqual([account, userTable]);
  });
});

it('recognizes the installation root separately from its legacy directories', () => {
  expect(
    isSyncablesPlatformRoot(
      'syncables:platform:https%3A%2F%2Fproxy.example:calendar-service',
    ),
  ).toBe(true);
  expect(isSyncablesPlatformRoot('syncables:accounts')).toBe(false);
  expect(isSyncablesPlatformRoot(nodeId('public'))).toBe(false);
});

const catalogNodeId = (overrides: Record<string, unknown> = {}) =>
  'syncables:node:' +
  encodeURIComponent(
    JSON.stringify({
      version: 2,
      proxyOrigin: 'https://proxy.example',
      platform: 'calendar-service',
      kind: 'collection',
      principal: {
        kind: 'authenticated',
        namespace: 'calendar-service',
        subject: 7,
      },
      collection: { name: 'Events', resource: 'events' },
      ...overrides,
    }),
  );

it('shows generic catalog collection children for authenticated and Public principals', () => {
  expect(isSyncablesNavigationTable(catalogNodeId())).toBe(true);
  expect(isSyncablesNavigationTable(catalogNodeId({ kind: 'principal' }))).toBe(
    true,
  );
  expect(
    isSyncablesNavigationTable(
      catalogNodeId({ principal: { kind: 'public' } }),
    ),
  ).toBe(true);
});

it.each([
  { version: 1 },
  { kind: 'mirror' },
  { proxyOrigin: null },
  { platform: '' },
  { principal: null },
  { principal: { kind: 'unknown' } },
])(
  'keeps malformed or non-directory catalog source %s out of the tree exception',
  source => {
    expect(isSyncablesNavigationTable(catalogNodeId(source))).toBe(false);
  },
);

it('keeps canonical entity tables as leaves while principals expose their entity types', () => {
  expect(isSyncablesNavigationTable(catalogNodeId({ kind: 'principal' }))).toBe(
    true,
  );

  for (const kind of [
    'collection',
    'record',
    'rule',
    'syncable-observation',
    'syncable-sync-run',
  ]) {
    expect(
      isSyncablesNavigationTable(
        catalogNodeId({ version: 3, kind, resource: 'workspaces' }),
      ),
    ).toBe(false);
  }
});
