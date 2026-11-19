import { expect, it } from 'vitest';
import { Resource } from './resource.js';

it('preserves null fields in JSON arrays through export and reopen', async () => {
  const property = 'https://example.com/labels';
  const value = [
    { name: 'Example', archived: null, nested: [null, { x: null }] },
  ];
  const resource = new Resource('https://example.com/record');
  await resource.set(property, value, false);
  const snapshot = resource.getLoroDoc()!.export({ mode: 'snapshot' });
  const reopened = new Resource(resource.subject);
  reopened.importLoroUpdate(snapshot);
  expect(reopened.get(property)).toEqual(value);
});
