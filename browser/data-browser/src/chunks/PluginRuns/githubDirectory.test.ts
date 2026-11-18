import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CollectionBuilder,
  core,
  dataBrowser,
  Datatype,
  ensureSchema,
  type Collection,
  type Store,
} from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  githubDirectoryRows,
  githubDirectoryType,
  openGithubDirectoryRow,
} from './githubDirectory';

const DRIVE_PROPERTY = 'https://atomicdata.dev/properties/drive';

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const { store: fake, resources } = fakeSchemaStore();
  resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
  });
  const terms = await ensureSchema(fake, 'drive', syncableHierarchySchema());
  const table = 'github-owners';
  resources.set(table, {
    [core.properties.parent]: 'drive',
    [core.properties.isA]: [dataBrowser.classes.table],
    [core.properties.classtype]: terms.classes['syncable-owner'],
    [dataBrowser.properties.tableViews]: ['owner-table-view'],
  });
  const store = Object.assign(fake, {
    // The table can be viewed while another drive is selected.
    getDrive: () => 'other-selected-drive',
  }) as unknown as Store;
  const queries: { drive?: string; property?: string; value?: string }[] = [];
  const extraMembers = new Map<string, string[]>();

  vi.spyOn(CollectionBuilder.prototype, 'build').mockImplementation(
    function (this: CollectionBuilder) {
      const params = (
        this as unknown as {
          params: { drive?: string; property?: string; value?: string };
        }
      ).params;
      queries.push({ ...params });

      return {
        getAllMembers: async () => [
          ...[...resources.entries()]
            .filter(([, values]) => {
              const stampedDrive = values[DRIVE_PROPERTY];

              return (
                params.property !== undefined &&
                values[params.property] === params.value &&
                (stampedDrive === undefined || stampedDrive === params.drive)
              );
            })
            .map(([subject]) => subject),
          ...(extraMembers.get(params.value ?? '') ?? []),
        ],
      } as unknown as Collection;
    },
  );

  const addOwner = (subject: string, name: string) => {
    resources.set(subject, {
      [core.properties.parent]: table,
      [core.properties.isA]: [terms.classes['syncable-owner']],
      [core.properties.name]: name,
      [terms.properties['syncable-owner-kind']]: 'organization',
    });
  };

  return { store, resources, terms, table, queries, extraMembers, addOwner };
}

describe('GitHub stored directory views', () => {
  it('uses this drive’s exact row classes without requiring a provider source', async () => {
    const { store, resources, terms, table } = await setup();
    await expect(githubDirectoryType(store, 'drive', table)).resolves.toBe(
      'organizations',
    );
    resources.get(table)![core.properties.classtype] =
      terms.classes['syncable-repository'];
    await expect(githubDirectoryType(store, 'drive', table)).resolves.toBe(
      'repositories',
    );
    resources.get(table)![core.properties.classtype] =
      'different-class-with-the-same-display-name';
    await expect(githubDirectoryType(store, 'drive', table)).rejects.toThrow(
      'This row type has no GitHub directory view',
    );
  });

  it('rejects a table with no row class before a GitHub schema exists', async () => {
    const { store, resources } = fakeSchemaStore();
    resources.set('empty-table', { [core.properties.parent]: 'drive' });

    await expect(
      githubDirectoryType(store as unknown as Store, 'drive', 'empty-table'),
    ).rejects.toThrow('This row type has no GitHub directory view');
  });

  it('lists stored direct rows and counts typed repositories while excluding view subjects', async () => {
    const { store, resources, terms, table, queries, extraMembers, addOwner } =
      await setup();
    addOwner('owner', 'ontola');
    resources.get('owner')![dataBrowser.properties.tableViews] = ['owner-view'];
    resources.set('owner-table-view', {
      [core.properties.parent]: table,
      [core.properties.isA]: [dataBrowser.classes.view],
    });
    resources.set('owner-view', {
      [core.properties.parent]: 'owner',
      [core.properties.isA]: [dataBrowser.classes.view],
    });
    resources.set('repository', {
      [core.properties.parent]: 'owner',
      [core.properties.isA]: [terms.classes['syncable-repository']],
    });
    // Names do not decide whether a resource is an internal view.
    resources.set('named-like-a-view', {
      [core.properties.parent]: 'owner',
      [core.properties.name]: 'Table',
    });
    resources.set('foreign-child', {
      [core.properties.parent]: 'owner',
      [DRIVE_PROPERTY]: 'another-drive',
    });
    resources.set('unrelated-row', {
      [core.properties.parent]: table,
      [core.properties.isA]: [terms.classes['syncable-repository']],
    });
    resources.set('moved-owner', {
      [core.properties.parent]: 'somewhere-else',
      [core.properties.isA]: [terms.classes['syncable-owner']],
    });
    extraMembers.set(table, ['moved-owner']);

    await expect(githubDirectoryRows(store, 'drive', table)).resolves.toEqual({
      rows: [
        {
          subject: 'owner',
          name: 'ontola',
          kind: 'organization',
          count: 1,
        },
      ],
      complete: true,
    });
    expect(queries.every(query => query.drive === 'drive')).toBe(true);
  });

  it('counts nested repository rows and opens the single repository table', async () => {
    const { store, resources, terms, table, extraMembers, addOwner } =
      await setup();
    addOwner('owner', 'ontola');
    resources.set('repositories', {
      [core.properties.parent]: 'owner',
      [core.properties.isA]: [dataBrowser.classes.table],
      [core.properties.classtype]: terms.classes['syncable-repository'],
      [dataBrowser.properties.tableViews]: ['repo-view'],
    });
    resources.set('repo-view', {
      [core.properties.parent]: 'repositories',
      [core.properties.isA]: [dataBrowser.classes.view],
    });
    for (const subject of ['server', 'plugins'])
      resources.set(subject, {
        [core.properties.parent]: 'repositories',
        [core.properties.isA]: [terms.classes['syncable-repository']],
      });
    resources.set('plain', {
      [core.properties.parent]: 'repositories',
      [core.properties.name]: 'Additional notes',
    });
    resources.set('foreign', {
      [core.properties.parent]: 'repositories',
      [core.properties.isA]: [terms.classes['syncable-repository']],
      [DRIVE_PROPERTY]: 'another-drive',
    });
    resources.set('moved', {
      [core.properties.parent]: 'elsewhere',
      [core.properties.isA]: [terms.classes['syncable-repository']],
    });
    extraMembers.set('repositories', ['moved', 'foreign']);

    expect(
      (await githubDirectoryRows(store, 'drive', table)).rows,
    ).toMatchObject([{ subject: 'owner', count: 2 }]);
    await expect(
      openGithubDirectoryRow(store, 'drive', table, 'owner'),
    ).resolves.toEqual({ subject: 'repositories' });

    resources.set('second-repositories', {
      ...resources.get('repositories'),
      [core.properties.parent]: 'owner',
    });
    await expect(
      openGithubDirectoryRow(store, 'drive', table, 'owner'),
    ).resolves.toEqual({ subject: 'owner' });
    resources.delete('second-repositories');
    resources.get('repositories')![DRIVE_PROPERTY] = 'another-drive';
    extraMembers.set('owner', ['repositories']);
    await expect(
      openGithubDirectoryRow(store, 'drive', table, 'owner'),
    ).resolves.toEqual({ subject: 'owner' });
  });

  it('opens only a direct row with the table’s class in its own drive', async () => {
    const { store, resources, terms, table, addOwner } = await setup();
    addOwner('owner', 'ontola');
    const originalSize = resources.size;
    await expect(
      openGithubDirectoryRow(store, 'drive', table, 'owner'),
    ).resolves.toEqual({ subject: 'owner' });
    expect(resources.size).toBe(originalSize);

    resources.get('owner')![core.properties.isA] = [
      terms.classes['syncable-repository'],
    ];
    await expect(
      openGithubDirectoryRow(store, 'drive', table, 'owner'),
    ).rejects.toThrow('This row does not belong to the GitHub table');

    addOwner('owner', 'ontola');
    resources.get('owner')![core.properties.parent] = 'different-table';
    await expect(
      openGithubDirectoryRow(store, 'drive', table, 'owner'),
    ).rejects.toThrow('This row does not belong to the GitHub table');

    addOwner('owner', 'ontola');
    resources.get('owner')![DRIVE_PROPERTY] = 'another-drive';
    await expect(
      openGithubDirectoryRow(store, 'drive', table, 'owner'),
    ).rejects.toThrow('This row does not belong to the GitHub table');
    await expect(
      openGithubDirectoryRow(store, 'drive', table, undefined),
    ).rejects.toThrow('Choose a GitHub row');
  });

  it('refuses an out-of-drive table and stops a cancelled directory read', async () => {
    const { store, resources, table, addOwner } = await setup();
    addOwner('owner', 'ontola');
    const controller = new AbortController();
    controller.abort(new Error('Directory closed'));
    await expect(
      githubDirectoryRows(store, 'drive', table, controller.signal),
    ).rejects.toThrow('Directory closed');

    resources.get(table)![DRIVE_PROPERTY] = 'another-drive';
    await expect(githubDirectoryType(store, 'drive', table)).rejects.toThrow(
      'This GitHub table is outside the current drive',
    );
  });
});
