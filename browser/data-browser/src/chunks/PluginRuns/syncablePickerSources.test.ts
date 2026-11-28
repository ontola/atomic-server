import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  core,
  dataBrowser,
  readConnectionSubjects,
  type Resource,
  type Store,
} from '@tomic/lib';
import {
  bindCollection,
  ontologyShortname,
  prepareDocument,
  readSelectionKey,
  type ReadSelection,
} from 'syncables/browser';
import { entityTableKey, ruleSourceKey } from './builtinSyncIdentity.js';
import type { SyncAppContext } from './builtinSyncablesProfile';
import catalog from './fixtures/github-syncables-catalog.json';
import { resolveSyncablePickerSources } from './syncablePickerSources';

vi.mock('@tomic/lib', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/lib')>()),
  readConnectionSubjects: vi.fn(),
}));

const document = prepareDocument(catalog);
const configProperty = 'atomic:sync-config';
const keyProperty = 'atomic:sync-key';
const owner = 'atomic:owner';
const principal = {
  kind: 'authenticated',
  namespace: 'https://github.example/users',
  subject: 17,
} as const;
const scope = {
  drive: 'atomic:drive',
  platform: 'github',
  proxyOrigin: 'https://proxy.example',
  principal,
};
const context: SyncAppContext = {
  ...scope,
  subject: 'atomic:issues',
  kind: 'collection',
  resource: 'issue',
  principalApp: 'atomic:principal',
  schema: {
    classes: {},
    properties: {
      'syncable-source-config': configProperty,
      'syncable-source-key': keyProperty,
    },
  },
  proxyTransport: 'host',
};
const schema = {
  classes: {
    [ontologyShortname('githubOrganization')]: 'atomic:org-type',
    [ontologyShortname('githubRepository')]: 'atomic:repo-type',
  },
  properties: {},
  resourceProperties: { githubRepository: { owner } },
};

function fixture() {
  const resources = new Map<string, Resource>();

  const put = (subject: string, values: Record<string, unknown> = {}) => {
    const getSubjects = (property: string) =>
      (values[property] as string[] | undefined) ?? [];
    resources.set(subject, {
      subject,
      get: (property: string) => values[property],
      getSubjects,
      hasClasses: (classSubject: string) =>
        getSubjects(core.properties.isA).includes(classSubject),
    } as unknown as Resource);

    return values;
  };

  const store = {
    resources,
    getResource: async (subject: string) => resources.get(subject),
    getServerUrl: () => 'http://localhost:52771',
    normalizeSubject: (subject: string) => subject,
  } as unknown as Store;

  put(scope.drive);
  put(context.principalApp!, { [core.properties.parent]: scope.drive });
  const tables = new Map<string, string[]>();
  vi.mocked(readConnectionSubjects).mockImplementation(
    async (_, drive, property, key) => {
      expect(drive).toBe(scope.drive);
      expect(property).toBe(keyProperty);

      return tables.get(key ?? '') ?? [];
    },
  );

  const add = (
    subject: string,
    resource: string,
    collection: string,
    parent = context.principalApp,
  ) => {
    const key = entityTableKey({ ...scope, resource });
    tables.set(key, [subject]);
    const config = {
      version: 3,
      kind: 'collection',
      proxyOrigin: scope.proxyOrigin,
      platform: scope.platform,
      principal,
      resource,
      connectionId: 'c'.repeat(43),
    };
    const table = put(subject, {
      [core.properties.parent]: parent,
      [core.properties.isA]: [dataBrowser.classes.table],
      [core.properties.classtype]: schema.classes[ontologyShortname(resource)],
      [keyProperty]: key,
      [configProperty]: config,
    });
    const definition: ReadSelection = {
      version: 1,
      resource,
      source: {
        kind: 'bound',
        bound: bindCollection(document, { collection }),
      },
    };
    const ruleSubject = subject + '-rule';
    const ruleKey = readSelectionKey(definition);
    const ruleIdentity = ruleSourceKey(key, ruleKey);
    const rule = put(ruleSubject, {
      [core.properties.parent]: subject,
      [core.properties.isA]: [dataBrowser.classes.view],
      [core.properties.localId]:
        'syncables:node:' + encodeURIComponent(ruleIdentity),
      [keyProperty]: ruleIdentity,
      [configProperty]: {
        version: 3,
        kind: 'rule',
        resource,
        definition,
        ruleKey,
      },
    });
    table[dataBrowser.properties.tableViews] = [ruleSubject];

    return { key, config, rule, ruleSubject, table };
  };

  return { store, add, put, tables };
}

describe('catalog-backed sync picker sources', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prepares the typed repository root filter within the selected drive', async () => {
    const { store, add, put } = fixture();
    put('atomic:folder', { [core.properties.parent]: scope.drive });
    const repo = add(
      'atomic:repos',
      'githubRepository',
      'githubRepositories',
      'atomic:folder',
    );
    put('atomic:manual-filter', {
      [core.properties.parent]: 'atomic:repos',
      [keyProperty]: 'not-a-catalog-root-rule',
    });
    (repo.table[dataBrowser.properties.tableViews] as string[]).push(
      'atomic:manual-filter',
    );

    expect(
      await resolveSyncablePickerSources(
        store,
        context,
        document,
        schema,
        () => {},
      ),
    ).toEqual([
      {
        resource: 'githubRepository',
        title: 'Repositories',
        table: 'atomic:repos',
        ruleSubjects: [repo.ruleSubject],
        collections: ['repositoryIssues'],
      },
    ]);
  });

  it('recognizes the picker without inventing a table for a different principal', async () => {
    const { store, add } = fixture();
    const repo = add('atomic:repos', 'githubRepository', 'githubRepositories');
    repo.table[configProperty] = {
      ...repo.config,
      principal: { ...principal, subject: 18 },
    };

    expect(
      await resolveSyncablePickerSources(
        store,
        context,
        document,
        schema,
        () => {},
      ),
    ).toMatchObject([
      {
        resource: 'githubRepository',
        ruleSubjects: [],
        collections: ['repositoryIssues'],
      },
    ]);
  });

  it('keeps public and non-enumerable direct parents out of the data picker', async () => {
    const { store } = fixture();

    for (const unavailable of [
      { ...context, principal: { kind: 'public' } as const },
      { ...context, resource: 'issueComment' },
    ]) {
      expect(
        await resolveSyncablePickerSources(
          store,
          unavailable,
          document,
          schema,
          () => {},
        ),
      ).toEqual([]);
    }

    expect(readConnectionSubjects).not.toHaveBeenCalled();
  });
});
