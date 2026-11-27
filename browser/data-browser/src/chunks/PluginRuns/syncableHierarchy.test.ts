import { describe, it, expect } from 'vitest';
import { Datatype } from '@tomic/lib';
import { syncableHierarchySchema } from './syncableHierarchy';

describe('stored integration discovery vocabulary', () => {
  it('leaves record fields to the catalog schema and keeps view metadata separate', () => {
    const schema = syncableHierarchySchema();
    expect(
      schema.classes.find(row => row.shortname === 'syncable-record')
        ?.recommends,
    ).toEqual(['name']);
    for (const [name, datatype] of [
      ['syncable-collection-view', Datatype.JSON],
      ['syncable-open-target', Datatype.ATOMIC_URL],
    ])
      expect(
        schema.properties.find(row => row.shortname === name)?.datatype,
      ).toBe(datatype);
  });
});
