import { beforeAll, describe, it } from 'vitest';
import * as Y from 'yjs';
import { Resource } from './resource.js';
import { enableYjs } from './yjs.js';
import { urls } from './urls.js';

const yProp = 'https://example.com/y-test-prop';

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
});

describe('Resource.merge Yjs', () => {
  beforeAll(async () => {
    await enableYjs();
  });

  it('replaceYDocs makes local Y.Doc match remote state (drops local-only CRDT ops)', ({
    expect,
  }) => {
    const subject = 'https://example.com/merge-y-replace';

    const local = new Resource(subject);
    const localDoc = new Y.Doc();
    const localFrag = localDoc.getXmlFragment('content');
    const localText = new Y.XmlText();
    localText.insert(0, 'local-only');
    localFrag.insert(0, [localText]);
    local.setUnsafe(yProp, localDoc);

    const remote = new Resource(subject);
    const remoteDoc = new Y.Doc();
    const remoteFrag = remoteDoc.getXmlFragment('content');
    const remoteText = new Y.XmlText();
    remoteText.insert(0, 'server');
    remoteFrag.insert(0, [remoteText]);
    remote.setUnsafe(yProp, remoteDoc);

    local.merge(remote, { replaceYDocs: true });

    const merged = local.get(yProp) as Y.Doc;
    expect(merged.getXmlFragment('content').toString()).toBe('server');
  });

  it('omitKeysFromMerge keeps local Y.Doc and does not adopt remote Y state', ({
    expect,
  }) => {
    const subject = 'https://example.com/merge-y-omit';

    const local = new Resource(subject);
    const localDoc = new Y.Doc();
    const localFrag = localDoc.getXmlFragment('content');
    const localText = new Y.XmlText();
    localText.insert(0, 'baseline');
    localFrag.insert(0, [localText]);
    local.setUnsafe(yProp, localDoc);

    const remote = new Resource(subject);
    const remoteDoc = new Y.Doc();
    const remoteFrag = remoteDoc.getXmlFragment('content');
    const remoteText = new Y.XmlText();
    remoteText.insert(0, 'live-with-ai');
    remoteFrag.insert(0, [remoteText]);
    remote.setUnsafe(yProp, remoteDoc);

    local.merge(remote, { omitKeysFromMerge: [yProp] });

    const kept = local.get(yProp) as Y.Doc;
    expect(kept.getXmlFragment('content').toString()).toBe('baseline');
  });
});
