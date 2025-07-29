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
});
