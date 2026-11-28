// @wc-ignore-file
/** Native vocabulary for a catalog-backed principal. */
import { Datatype, type SchemaSpec } from '@tomic/lib';
import { syncableNameProperty } from './syncablePlatform';

export const syncableHierarchySchema = (): SchemaSpec => ({
  properties: [
    syncableNameProperty,
    {
      shortname: 'syncable-source-config',
      name: 'Syncable source configuration',
      description: 'Non-secret source and connection bindings.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-source-key',
      name: 'Syncable source identity',
      description:
        'Canonical provider and principal identity, independent of Atomic parent.',
      datatype: Datatype.STRING,
    },
    {
      shortname: 'syncable-node-kind',
      name: 'Syncable node kind',
      description: 'Role of this resource in the discovery hierarchy.',
      datatype: Datatype.STRING,
    },
  ],
  classes: [
    {
      shortname: 'syncable-principal',
      name: 'Syncable principal',
      description:
        'A catalog-declared authenticated identity or an anonymous public source.',
      recommends: ['name'],
    },
  ],
});
