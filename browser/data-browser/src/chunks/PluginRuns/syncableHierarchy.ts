// @wc-ignore-file
/** Vocabulary installed natively; discovery and reconciliation live in the app. */
import { Datatype, type SchemaSpec } from '@tomic/lib';
import { syncableNameProperty } from './syncablePlatform';

export const syncableHierarchySchema = (): SchemaSpec => ({
  properties: [
    syncableNameProperty,
    ...(
      [
        ['syncable-repository-count', 'Visible repositories', Datatype.INTEGER],
        ['syncable-repository-private', 'Private repository', Datatype.BOOLEAN],
        ['syncable-repository-has-issues', 'Issues enabled', Datatype.BOOLEAN],
        [
          'syncable-repository-open-issues',
          'Open issues and pull requests',
          Datatype.INTEGER,
        ],
      ] as const
    ).map(([shortname, name, datatype]) => ({
      shortname,
      name,
      datatype,
      description: name,
    })),
    {
      shortname: 'syncable-collection-view',
      name: 'Syncable collection view',
      description:
        'Declarative columns and navigation for saved collection rows.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-open-target',
      name: 'Syncable open target',
      description: 'A saved child table to open from a collection row.',
      datatype: Datatype.ATOMIC_URL,
    },
    {
      shortname: 'syncable-mirror-status',
      name: 'Mirror status',
      description: 'Last acknowledged synchronization and pause state.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-issue-number',
      name: 'GitHub issue number',
      description: 'Stable issue number within its repository.',
      datatype: Datatype.INTEGER,
    },
    {
      shortname: 'syncable-issue-state',
      name: 'Issue state',
      description: 'Open or closed at last successful read.',
      datatype: Datatype.STRING,
    },
    {
      shortname: 'syncable-issue-updated',
      name: 'Updated at',
      description: 'Last GitHub update timestamp.',
      datatype: Datatype.TIMESTAMP,
    },
    {
      shortname: 'syncable-issue-link',
      name: 'Issue URL',
      description: 'Canonical GitHub issue link.',
      datatype: Datatype.URI,
    },
    {
      shortname: 'syncable-issue-body',
      name: 'Issue body',
      description: 'GitHub issue description in Markdown.',
      datatype: Datatype.MARKDOWN,
    },
    {
      shortname: 'syncable-source-config',
      name: 'Syncable source configuration',
      description:
        'Non-secret source bindings and selected collection parameters.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-resource-index',
      name: 'Syncable resource index',
      description:
        'Drive-level lookup of synced resources by canonical source key.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-source-key',
      name: 'Syncable source identity',
      description:
        'Canonical proxy/platform/kind/remote binding, independent of Atomic parent.',
      datatype: Datatype.STRING,
    },
    {
      shortname: 'syncable-node-kind',
      name: 'Syncable node kind',
      description: 'Role of this resource in the discovery hierarchy.',
      datatype: Datatype.STRING,
    },
    {
      shortname: 'syncable-owner-kind',
      name: 'Remote owner kind',
      description:
        'Whether this owner namespace is an organization or personal account.',
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
    {
      shortname: 'syncable-account',
      name: 'Syncable account',
      description: 'An authorized remote account.',
      recommends: ['name'],
    },
    {
      shortname: 'syncable-owner',
      name: 'Syncable owner namespace',
      description: 'A remote organization or personal repository owner.',
      recommends: ['name'],
    },
    {
      shortname: 'syncable-repository',
      name: 'Syncable repository',
      description: 'A repository within its canonical remote owner namespace.',
      recommends: ['name'],
    },
    {
      shortname: 'syncable-record',
      name: 'Syncable record',
      description: 'A record mirrored from a selected remote collection.',
      recommends: [
        'name',
        'syncable-issue-number',
        'syncable-issue-state',
        'syncable-issue-updated',
        'syncable-issue-link',
        'syncable-issue-body',
      ],
    },
  ],
});
