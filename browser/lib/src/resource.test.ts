import { describe, it } from 'vitest';
import { Resource } from './resource.js';

describe('resource.ts', () => {
  it('push propvals', ({ expect }) => {
    const resource = new Resource('test');
    const testsubject = 'https://example.com/testsubject';
    resource.push('https://atomicdata.dev/properties/subresources', [testsubject], true);
    resource.push('https://atomicdata.dev/properties/subresources', [testsubject], true);

    expect(resource.get('https://atomicdata.dev/properties/subresources')).toStrictEqual([
      testsubject,
    ]);

    const testsubject2 = 'https://example.com/testsubject2';

    resource.push(
      'https://atomicdata.dev/properties/subresources',
      [testsubject2, testsubject2],
      true,
    );

    expect(resource.get('https://atomicdata.dev/properties/subresources')).toStrictEqual([
      testsubject,
      testsubject2,
    ]);

    resource.push('https://atomicdata.dev/properties/subresources', [testsubject, testsubject]);

    expect(resource.get('https://atomicdata.dev/properties/subresources')).toStrictEqual([
      testsubject,
      testsubject2,
      testsubject,
      testsubject,
    ]);
  });

  it('merges remote state without dropping local unsaved loro edits', async ({
    expect,
  }) => {
    const subject = 'https://example.com/merge-test';
    const name = 'https://atomicdata.dev/properties/name';
    const description = 'https://atomicdata.dev/properties/description';

    const base = new Resource(subject);
    await base.set(name, 'Base', false);
    const baseSnapshot = (base as any)._loroDoc.export({ mode: 'snapshot' }) as Uint8Array;

    const local = new Resource(subject);
    local.importLoroUpdate(baseSnapshot);
    await local.set(description, 'Local unsaved edit', false);

    const remoteSource = new Resource(subject);
    remoteSource.importLoroUpdate(baseSnapshot);
    await remoteSource.set(name, 'Remote update', false);
    const remoteSnapshot = (remoteSource as any)._loroDoc.export({
      mode: 'snapshot',
    }) as Uint8Array;

    const remote = new Resource(subject);
    remote.importLoroUpdate(remoteSnapshot);

    local.merge(remote);

    expect(local.get(name)).toBe('Remote update');
    expect(local.get(description)).toBe('Local unsaved edit');
    expect(local.hasUnsavedChanges()).toBe(true);
  });
});
