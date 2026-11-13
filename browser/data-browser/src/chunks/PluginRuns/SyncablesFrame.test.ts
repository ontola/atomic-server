import { describe, expect, it } from 'vitest';
import { isBuiltinSyncablesRequest } from './SyncablesFrame';

describe('built-in Syncables iframe protocol boundary', () => {
  it('recognizes explicitly permitted host operations', () => {
    expect(
      isBuiltinSyncablesRequest({
        type: 'atomic.view.request',
        version: 1,
        id: 'syncables:17',
        op: 'syncablesOpenOwner',
        args: {
          connectionId: 'test-connection',
          ownerId: '123',
          ownerLogin: 'ontola',
          ownerKind: 'organization',
        },
      }),
    ).toBe(true);
  });

  it('rejects unknown operations, non-Syncables ids and malformed args', () => {
    const request = {
      type: 'atomic.view.request',
      version: 1,
      id: 'syncables:1',
      op: 'syncablesContext',
      args: {},
    };
    expect(isBuiltinSyncablesRequest({ ...request, op: 'syncablesDeleteEverything' })).toBe(false);
    expect(isBuiltinSyncablesRequest({ ...request, op: 'save' })).toBe(false);
    expect(isBuiltinSyncablesRequest({ ...request, id: '1' })).toBe(false);
    expect(isBuiltinSyncablesRequest({ ...request, args: [] })).toBe(false);
    expect(isBuiltinSyncablesRequest({ ...request, version: 2 })).toBe(false);
  });
});
