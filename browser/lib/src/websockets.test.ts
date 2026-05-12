import { describe, it } from 'vitest';
import { Resource } from './resource.js';
import { Store } from './store.js';
import { shouldFetchOnQueryUpdate } from './websockets.js';

describe('shouldFetchOnQueryUpdate', () => {
  it('skips already-known commit subjects', ({ expect }) => {
    const store = new Store();
    const commitSubject =
      'did:ad:commit:6iEQsRehyMJ5cifsDt3fB8mK0IdPEovMMLfZ59BtYASl1P5UdtE1QTbh3hFIv48GzDt/b2TbMNVA9IIBo6o1BA==';
    store.addResource(new Resource(commitSubject));

    expect(shouldFetchOnQueryUpdate(commitSubject, store)).toBe(false);
  });

  it('still fetches unknown commit subjects', ({ expect }) => {
    const store = new Store();
    const commitSubject = 'did:ad:commit:NEW_COMMIT_NOT_YET_IN_STORE==';

    expect(shouldFetchOnQueryUpdate(commitSubject, store)).toBe(true);
  });

  it('always fetches non-commit subjects, even when present', ({ expect }) => {
    // Regular (non-commit) resources are mutable. A QUERY_UPDATE `added`
    // for a subject we already have may signal a new version. Per-version
    // dedup happens inside `applyIncoming` based on commit-id; we don't
    // try to second-guess at this layer.
    const store = new Store();
    const resourceSubject =
      'did:ad:6iEQsRehyMJ5cifsDt3fB8mK0IdPEovMMLfZ59BtYASl1P5UdtE1QTbh3hFIv48GzDt/b2TbMNVA9IIBo6o1BA==';
    store.addResource(new Resource(resourceSubject));

    expect(shouldFetchOnQueryUpdate(resourceSubject, store)).toBe(true);
  });

  it('always fetches HTTP-URL subjects (legacy non-DID resources)', ({
    expect,
  }) => {
    const store = new Store();
    const httpSubject = 'http://localhost:9883/my-resource';
    store.addResource(new Resource(httpSubject));

    expect(shouldFetchOnQueryUpdate(httpSubject, store)).toBe(true);
  });
});
