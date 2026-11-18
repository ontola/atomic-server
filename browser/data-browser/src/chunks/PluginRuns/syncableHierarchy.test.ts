import { describe, it, expect } from 'vitest';
import { Datatype } from '@tomic/lib';
import { syncableHierarchySchema } from './syncableHierarchy';

describe('stored GitHub discovery vocabulary', () => {
  it('stores typed display metadata without adding custom-view columns to raw owner/repository tables', () => {
    const schema = syncableHierarchySchema();
    for (const name of ['syncable-owner', 'syncable-repository'])
      expect(
        schema.classes.find(row => row.shortname === name)?.recommends,
      ).toEqual(['name']);
    for (const [name, datatype] of [
      ['syncable-repository-count', Datatype.INTEGER],
      ['syncable-repository-private', Datatype.BOOLEAN],
      ['syncable-repository-has-issues', Datatype.BOOLEAN],
      ['syncable-repository-open-issues', Datatype.INTEGER],
    ])
      expect(
        schema.properties.find(row => row.shortname === name)?.datatype,
      ).toBe(datatype);
  });
});
