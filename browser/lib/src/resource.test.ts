import { describe, it, vi } from 'vitest';
import { Resource } from './resource.js';
import { urls } from './urls.js';

describe('resource.ts', () => {
  it('push propvals', ({ expect }) => {
    const resource = new Resource('test');
    const testsubject = 'https://example.com/testsubject';
    resource.push(urls.properties.subResources, [testsubject], true);
    resource.push(urls.properties.subResources, [testsubject], true);

    expect(resource.get(urls.properties.subResources)).toStrictEqual([
      testsubject,
    ]);

    const testsubject2 = 'https://example.com/testsubject2';

    resource.push(
      urls.properties.subResources,
      [testsubject2, testsubject2],
      true,
    );

    expect(resource.get(urls.properties.subResources)).toStrictEqual([
      testsubject,
      testsubject2,
    ]);

    resource.push(urls.properties.subResources, [testsubject, testsubject]);

    expect(resource.get(urls.properties.subResources)).toStrictEqual([
      testsubject,
      testsubject2,
      testsubject,
      testsubject,
    ]);
  });

  it('maintains unbreakable commit chain even if prop lastCommit is clobbered', async ({
    expect,
  }) => {
    // This test simulates Step 2 of onboarding where a remote merge might
    // clobber the local lastCommit property before the next save.
    const resource = new Resource('https://example.com/res');
    const store = {
      getServerUrl: () => 'https://example.com',
      getAgent: () => ({ subject: 'agent', sign: async () => 'sig' }),
      postCommit: vi.fn(async commit => ({ id: `commit-${commit.signature}` })),
      addResources: vi.fn(),
      notifyResourceSaved: vi.fn(),
      isOffline: () => false,
      batchResource: vi.fn(),
      saveBatchForParent: vi.fn(),
      subscribeWebSocket: vi.fn(),
    } as any;
    resource.setStore(store);

    // 1. Initial Save
    await resource.set('https://example.com/p1', 'val1', false);
    await resource.save();
    const firstCommitId = resource.get(
      'https://atomicdata.dev/properties/lastCommit',
    );
    expect(firstCommitId).toBeDefined();

    // 2. Simulate Remote Merge clobbering the property (e.g. from an old websocket message)
    const clobberedResource = new Resource('https://example.com/res');
    // It has no lastCommit!
    resource.merge(clobberedResource);
    expect(
      resource.get('https://atomicdata.dev/properties/lastCommit'),
    ).toBeUndefined();

    // 3. Second Save
    await resource.set('https://example.com/p2', 'val2', false);
    await resource.save();

    // The second save MUST have used the first commit as previousCommit
    // despite the property being missing.
    const secondCommitCall = store.postCommit.mock.calls[1][0];
    expect(secondCommitCall.previousCommit).toBe(firstCommitId);
  });
});
