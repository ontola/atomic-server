// @wc-ignore-file
/** Vocabulary installed natively; discovery and reconciliation live in the app. */
import { Datatype, type SchemaSpec } from '@tomic/lib';
import { syncableNameProperty } from './syncablePlatform';

export const syncableHierarchySchema = (): SchemaSpec => ({
  properties: [
    syncableNameProperty,
    {
      shortname: 'syncable-reference-diagnostics',
      name: 'Linked record diagnostics',
      description:
        'Unresolved catalog-declared linked fields retained alongside raw provider evidence.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-reference-evidence',
      name: 'Linked record evidence',
      description:
        'Declared source field and supplied record that establish an identity-only reference.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-entity-table',
      name: 'Canonical entity collection',
      description:
        'Logical collection ownership, retained when a row is moved.',
      datatype: Datatype.ATOMIC_URL,
    },
    {
      shortname: 'syncable-rule-memberships',
      name: 'Sync rule memberships',
      description:
        'Saved filters whose observations include this canonical row.',
      datatype: Datatype.RESOURCEARRAY,
    },
    {
      shortname: 'syncable-navigation-intents',
      name: 'Syncable relationship navigation',
      description:
        'Declared relationship selections for native filtered navigation.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-observation',
      name: 'Syncable observation',
      description:
        'Typed field evidence and provenance retained for one rule run and entity.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-sync-run',
      name: 'Sync rule run',
      description:
        'Run generation, completeness and observed entity membership for one saved filter.',
      datatype: Datatype.JSON,
    },
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
      shortname: 'syncable-reference',
      name: 'Linked record summary',
      description:
        'A catalog-declared linked record whose supplied data may be incomplete.',
      recommends: ['name', 'syncable-source-config'],
    },
    {
      shortname: 'syncable-observation',
      name: 'Syncable observation',
      description: 'Retained provider evidence from one saved filter and run.',
      requires: ['syncable-observation'],
    },
    {
      shortname: 'syncable-sync-run',
      name: 'Sync rule run',
      description: 'A retained synchronization attempt for one saved filter.',
      requires: ['syncable-sync-run'],
    },
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
