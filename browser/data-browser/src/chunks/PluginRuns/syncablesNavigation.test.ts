import { describe, expect, it } from 'vitest';
import {
  isSyncablesNavigationTable,
  withoutTableViews,
} from './syncablesNavigation';

const nodeId = (kind: string, connection?: string) => {
  const key = ['https://proxy.example', 'github-issues', kind, 'remote-id', ''];
  if (connection) key.push(connection);

  return 'syncables:node:' + encodeURIComponent(JSON.stringify(key));
};

it('exposes the built-in App Accounts table children without exposing ordinary table rows', () => {
  expect(isSyncablesNavigationTable('syncables:accounts')).toBe(true);
  expect(isSyncablesNavigationTable('syncables:accounts-extra')).toBe(false);
});

describe('Syncables navigation tables', () => {
  it.each([
    'syncables:platform:https%3A%2F%2Fproxy.example:github-issues',
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
    nodeId('account'),
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
