// @wc-ignore-file
import {
  prepareDocument,
  describeCollections,
  bindCollection,
  bindCollectionNavigation,
  relatedCollectionReads,
  resolveCollectionNavigation,
  describeEntityTypes,
  compileReadSelection,
  readSelectionKey,
  readSelection,
  resolveAuthenticatedPrincipal,
  ontologyShortname,
  describeResourceFields,
  resolveResourceField,
  resolveEntityIdentity,
  type CollectionDescription,
  type CollectionNavigation,
  type EntityObservation,
  type EntityTypeDescription,
  type OpenApiDocument,
  type OriginRecord,
  type ReadSelection,
  type ResourceFieldDescription,
  type TransportRequest,
  type TransportResponse,
} from 'syncables/browser';
import {
  canonicalValue,
  principalIdentity,
  sourceKey,
  sourceConfigFingerprint,
  entityTableKey,
  entitySourceKey,
  ruleSourceKey,
  type FlatIdentityAlias,
  type SourceKeyInput,
  type SyncablePrincipal,
} from './builtinSyncIdentity.js';
import {
  reduceFlatState,
  type DurableEntityObservation,
  type DurableSyncRun,
} from './builtinSyncFlatState.js';
import { validateSyncableReferenceEvidence } from './builtinSyncReferenceIdentity.js';

import type { ViewQuery } from '@helpers/extensions/viewQuery';
import type { ConnectionReference } from '@helpers/proxyConnections';
import type { HostRequest } from '../AppPage/hostStore';
import type { SyncAppContext } from './builtinSyncablesProfile';
import type {
  FlatMigrationBlock,
  SyncableFlatAdoptionRule,
} from './syncableFlatAdoption';
import type { SyncablePickerSource } from './syncablePickerSources';
import type { SyncablePrincipalAppRef } from './syncablePrincipalApp';
import type { SyncableRuleConfig, SyncableRuleRun } from './syncableRules';
import type {
  SyncableSourceConfig,
  SyncableSourceConfigV3,
  SyncableSourceKey,
} from './syncableSource';

type Values = Record<string, unknown>;
type StoredSource = SyncableSourceConfig | SyncableRuleConfig;
type StoredRecordSource = SyncableSourceConfigV3 & {
  kind: 'record';
  entityIdentity: OriginRecord['entity'];
  record: OriginRecord['record'];
};
type SyncObservation = DurableEntityObservation & EntityObservation;
type ResourceQuery = Required<Pick<ViewQuery, 'property' | 'value'>>;
type CreateResource = Required<
  Pick<HostRequest, 'parent' | 'isA' | 'propVals'>
>;
type ProxyRequest = Required<
  Pick<HostRequest, 'platform' | 'path' | 'method'>
> &
  Pick<HostRequest, 'connectionId' | 'body' | 'readProgress'> & {
    query: Record<string, string>;
  };

interface AppResource {
  subject: string;
  error?: undefined;
  get(property: string): unknown;
  set(property: string, value: unknown): unknown;
  remove(property: string): unknown;
  hasClasses(...classes: string[]): boolean;
  save(): Promise<unknown>;
}

interface AppResourceFailure {
  subject: string;
  error: string;
}

interface ExecutionState {
  running: boolean;
  queued?: boolean;
  progress?: { page: number; total?: number };
}

export interface SyncAppStore {
  query(
    args: ResourceQuery & Pick<ViewQuery, 'page' | 'pageSize'>,
  ): Promise<string[]>;
  getResource(subject: string): Promise<AppResource>;
  getMany(subjects: string[]): Promise<(AppResource | AppResourceFailure)[]>;
  newResource(args: CreateResource): Promise<AppResource>;
  getContext(): Promise<SyncAppViewContext>;
  subscribe?(subject: string, callback: () => void): () => void;
  execution(action: 'start' | 'state' | 'cancel'): Promise<ExecutionState>;
  proxy: {
    request(args: ProxyRequest): Promise<{
      status: number;
      headers: TransportResponse['headers'];
      body: unknown;
    }>;
    connections(args: { platform: string }): Promise<ConnectionReference[]>;
    connect(args: {
      platform: string;
      connectionId?: string;
    }): Promise<
      | { status: 'connected'; connectionId: string; platform: string }
      | { status: 'cancelled' }
    >;
  };
  ui: { openResource(subject: string): Promise<unknown> };
}

export interface SyncAppViewContext extends SyncAppContext {
  document?: OpenApiDocument;
  preferredConnectionId?: string;
  principalApps?: readonly SyncablePrincipalAppRef[];
  adoptionWarnings?: readonly string[];
  flatIdentityAliases?: readonly FlatIdentityAlias[];
  flatMigrationBlocks?: readonly FlatMigrationBlock[];
  flatAdoptionRules?: readonly SyncableFlatAdoptionRule[];
  pickerSources?: readonly SyncablePickerSource[];
}

interface NodeValues {
  key: string;
  kind: string;
  parent?: string;
  isA: string[];
  values: Values;
}
interface SyncCounts {
  added: number;
  changed: number;
  unchanged: number;
  protected?: number;
}
interface SyncStatus extends Partial<SyncCounts> {
  paused?: boolean;
  enabled?: boolean;
  run?: SyncableRuleRun;
  lastSuccess?: string;
  rows?: number;
  incomplete?: boolean;
  error?: string | null;
}
interface PickerRow {
  row: AppResource;
  name: string;
  origin: StoredRecordSource;
}

// These properties are read via the native store. Validation and authorization
// remain in the host, including when a frame reads legacy stored values.
function stored<T>(row: AppResource, property: string): T | undefined {
  return row.get(property) as T | undefined;
}

function readable(row: AppResource | AppResourceFailure): row is AppResource {
  return row.error === undefined;
}

function messageOf(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message ?? error);
}

const P = 'https://atomicdata.dev/properties/';
const core = Object.fromEntries(
  ['name', 'localId', 'parent', 'isA', 'classtype', 'requires'].map(key => [
    key,
    P + key,
  ]),
);
const tableClass = 'https://atomicdata.dev/classes/Table';
const viewClass = 'https://atomicdata.dev/classes/View';
const tableViews = P + 'table-views';
const defaultView = P + 'table-default-view';
const viewKind = P + 'view-kind';
const same = (left: unknown, right: unknown) =>
  JSON.stringify(canonicalValue(left)) ===
  JSON.stringify(canonicalValue(right));

const relatedSelection = (
  navigation: CollectionNavigation,
  origin: OriginRecord,
): ReadSelection => ({
  version: 1,
  resource: navigation.resource,
  source: {
    kind: 'related',
    origin,
    via: {
      collection: navigation.collection,
      kind: navigation.kind === 'responseLink' ? 'responseLink' : 'identity',
      ...('reference' in navigation && navigation.reference
        ? { reference: navigation.reference }
        : {}),
      ...('link' in navigation && navigation.link
        ? { link: navigation.link }
        : {}),
    },
  },
});

class PrincipalAuthorizationError extends Error {
  constructor(
    readonly connectionId: string | undefined,
    expired: boolean,
  ) {
    super(
      expired
        ? 'This connection has expired. Connect the account again to restore access.'
        : 'This connection could not authorize its account. Connect again to restore access.',
    );
  }
}

/** Catalog interpretation belongs to Syncables; all I/O uses the shared app store. */
export function createSyncApp(
  store: SyncAppStore,
  context: SyncAppViewContext,
) {
  const root = context.subject;

  const property = (name: string) => {
    const subject = context.schema?.properties[name];
    if (!subject) throw new Error('The Sync schema is unavailable');

    return subject;
  };

  const klass = (name: string) => {
    const subject = context.schema?.classes[name];
    if (!subject) throw new Error('The Sync row schema is unavailable');

    return subject;
  };

  let document: OpenApiDocument | undefined;

  const readDocument = () => {
    if (!context.document)
      throw new Error('The integration API description is unavailable');

    return (document ??= prepareDocument(context.document));
  };

  let catalog: CollectionDescription[] | undefined;
  const descriptions = () => (catalog ??= describeCollections(readDocument()));

  const description = (name: string) => {
    const matches = descriptions().filter(item => item.name === name);
    if (matches.length !== 1)
      throw new Error('Unknown or ambiguous collection ' + name);

    return matches[0];
  };

  const requirePrincipal = () => {
    if (!context.principal) throw new Error('Choose a principal first');

    return context.principal;
  };

  const identity = (values: Pick<SourceKeyInput, 'kind' | 'principal'>) =>
    sourceKey({
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      ...values,
    });

  async function queryAll(args: ResourceQuery) {
    const subjects: string[] = [];

    for (let page = 0; page < 200; page++) {
      const chunk = await store.query({ ...args, page, pageSize: 100 });
      subjects.push(...chunk);
      if (chunk.length < 100) return [...new Set(subjects)];
    }

    throw new Error('Atomic query limit reached; cached rows were retained');
  }

  async function resources(args: ResourceQuery) {
    const subjects = await queryAll(args);
    const found: AppResource[] = [];
    for (let i = 0; i < subjects.length; i += 100)
      found.push(
        ...(await store.getMany(subjects.slice(i, i + 100))).filter(readable),
      );

    return found;
  }

  async function withinRoot(subject: string | undefined) {
    const seen = new Set();

    for (let depth = 0; subject && depth < 64 && !seen.has(subject); depth++) {
      if (subject === root) return true;
      seen.add(subject);
      subject = stored<string>(await store.getResource(subject), core.parent);
    }

    return false;
  }

  async function patch(
    row: AppResource,
    values: Values,
    remove: string[] = [],
  ) {
    // A global source lookup never extends this frame's host-selected write scope.
    if (!(await withinRoot(row.subject))) return false;
    const changed = Object.entries(values).filter(
      ([key, value]) => value !== undefined && !same(row.get(key), value),
    );
    const removed = remove.filter(key => row.get(key) !== undefined);
    for (const [key, value] of changed) row.set(key, value);
    for (const key of removed) row.remove(key);
    if (changed.length || removed.length) await row.save();

    return changed.length > 0 || removed.length > 0;
  }

  const adoptionMatches = new Map<string, FlatIdentityAlias>();

  async function adoptableNode(key: string, existingSubject?: string) {
    const matches: AppResource[] = [];

    for (const alias of context.flatIdentityAliases ?? []) {
      if (alias.canonicalSourceKey !== key || alias.subject === existingSubject)
        continue;
      const row = await store.getResource(alias.subject);
      if (
        row.error ||
        (alias.previousSourceKey !== undefined &&
          row.get(property('syncable-source-key')) !==
            alias.previousSourceKey) ||
        (alias.localId !== undefined &&
          row.get(core.localId) !== alias.localId) ||
        (alias.sourceConfigFingerprint !== undefined &&
          sourceConfigFingerprint(
            stored<StoredSource>(row, property('syncable-source-config')),
          ) !== alias.sourceConfigFingerprint)
      )
        throw new Error(
          'The older entity source changed; no duplicate was created',
        );
      matches.push(row);
      adoptionMatches.set(row.subject, alias);
    }

    if (new Set(matches.map(row => row.subject)).size > 1)
      throw new Error('The saved source identity is ambiguous');

    return matches[0];
  }

  async function findNode(key: string, expectedClass: string, kind: string) {
    const matches = await resources({
      property: property('syncable-source-key'),
      value: key,
    });
    if (matches.length > 1) throw new Error('The source identity is ambiguous');
    const row = matches[0];

    if (row) {
      const savedConfig = stored<StoredSource>(
        row,
        property('syncable-source-config'),
      );
      let referenceIdentityProven = false;

      if (
        !row.hasClasses(expectedClass) &&
        savedConfig?.version === 3 &&
        savedConfig.kind === 'record' &&
        savedConfig.entityIdentity
      ) {
        try {
          referenceIdentityProven = same(
            resolveEntityIdentity(readDocument(), {
              resource: savedConfig.resource,
              record: savedConfig.record!,
              context: savedConfig.context,
            }),
            savedConfig.entityIdentity,
          );
        } catch {
          /* Scalar references retain their declaring source evidence. */
        }

        if (
          !referenceIdentityProven &&
          context.schema?.properties['syncable-reference-evidence']
        )
          referenceIdentityProven = validateSyncableReferenceEvidence(
            readDocument(),
            row.get(property('syncable-reference-evidence')),
            savedConfig.entityIdentity,
          );
      }

      const partialReference =
        kind === 'record' &&
        context.schema?.classes['syncable-reference'] &&
        row.hasClasses(context.schema?.classes['syncable-reference']) &&
        savedConfig?.version === 3 &&
        savedConfig.kind === 'record' &&
        savedConfig.entityIdentity &&
        referenceIdentityProven &&
        entitySourceKey({
          ...savedConfig,
          entityIdentity: savedConfig.entityIdentity,
        }) === key;
      if (
        (!row.hasClasses(expectedClass) && !partialReference) ||
        row.get(property('syncable-node-kind')) !== kind
      )
        throw new Error('The source identity does not match its resource');

      const desired = JSON.parse(key) as SyncableSourceKey;

      if (
        desired.version === 3 &&
        ['collection', 'record'].includes(desired.kind)
      ) {
        const saved = stored<StoredSource>(
          row,
          property('syncable-source-config'),
        );
        const expected =
          saved?.kind === 'record' && saved.entityIdentity
            ? entitySourceKey({
                ...saved,
                entityIdentity: saved.entityIdentity,
              })
            : saved?.kind === 'collection'
              ? entityTableKey(saved)
              : undefined;
        if (expected !== key)
          throw new Error(
            'The full canonical entity identity does not match its saved key',
          );
      }

      if (await adoptableNode(key, row.subject))
        throw new Error(
          'This account or collection has conflicting saved sources. Review its migration before syncing; all saved data was retained.',
        );

      return row;
    }

    return adoptableNode(key);
  }

  async function updateNode(
    row: AppResource,
    { key, kind, isA, values, parent }: NodeValues,
    remove: string[] = [],
  ) {
    const migrated = row.get(property('syncable-source-key')) !== key;
    const alias = adoptionMatches.get(row.subject);
    const relocate =
      migrated &&
      alias?.reparentToLogicalParent &&
      alias.previousParent === row.get(core.parent) &&
      parent &&
      (await withinRoot(row.subject)) &&
      (await withinRoot(parent));

    return patch(
      row,
      {
        ...(!isA.every(subject => row.hasClasses(subject))
          ? {
              [core.isA]: [
                ...new Set([
                  ...(stored<string[]>(row, core.isA) ?? []),
                  ...isA,
                ]),
              ],
            }
          : {}),
        ...(migrated
          ? {
              [property('syncable-source-key')]: key,
              [property('syncable-node-kind')]: kind,
              [core.isA]: [
                ...new Set([
                  ...(stored<string[]>(row, core.isA) ?? []),
                  ...isA,
                ]),
              ],
            }
          : {}),
        ...(relocate ? { [core.parent]: parent } : {}),
        ...values,
      },
      remove,
    );
  }

  async function ensureViews(row: AppResource) {
    const subjects = stored<string[]>(row, tableViews) ?? [];
    const definitions = (await store.getMany(subjects)).filter(readable);
    const kinds = definitions
      .filter(
        definition =>
          !definition.error &&
          stored<StoredSource>(definition, property('syncable-source-config'))
            ?.kind !== 'rule',
      )
      .map(definition => definition.get(viewKind));
    const added = [];
    const config = stored<StoredSource>(
      row,
      property('syncable-source-config'),
    );
    const entity = config?.version === 3 && config.kind === 'collection';
    const defaultKind = entity ? 'table' : 'syncable-collection';
    let preferred = definitions.find(
      definition =>
        !definition.error &&
        stored<StoredSource>(definition, property('syncable-source-config'))
          ?.kind !== 'rule' &&
        definition.get(viewKind) === defaultKind,
    )?.subject;

    for (const [name, kind] of [
      ...(!entity ? [['Syncable Collections', 'syncable-collection']] : []),
      ['Table', 'table'],
      ['Sync', 'syncables'],
    ]) {
      if (kinds.includes(kind)) continue;
      const definition = await store.newResource({
        parent: row.subject,
        isA: [viewClass],
        propVals: { [core.name]: name, [viewKind]: kind },
      });
      added.push(definition.subject);
      if (kind === defaultKind) preferred = definition.subject;
    }

    if (added.length)
      await patch(row, {
        [tableViews]: [...subjects, ...added],
        ...(!row.get(defaultView) && preferred
          ? { [defaultView]: preferred }
          : {}),
      });
  }

  async function ensureNode({
    key,
    kind,
    parent,
    name,
    isA,
    values = {},
  }: Omit<NodeValues, 'parent' | 'values'> & {
    parent: string;
    name: string;
    values?: Values;
  }): Promise<AppResource> {
    let row = await findNode(key, isA[0], kind);

    if (row) {
      await updateNode(row, { key, kind, isA, values, parent });
      if (isA.includes(tableClass) && (await withinRoot(row.subject)))
        await ensureViews(row);

      return row;
    }

    if (!(await withinRoot(parent)))
      throw new Error(
        'Open the moved resource to sync at its current location',
      );
    const desired = JSON.parse(key) as SyncableSourceKey;
    const block = (context.flatMigrationBlocks ?? []).find(
      item =>
        item.resource === desired.resource &&
        same(item.principal, desired.principal),
    );
    if (block) throw new Error(block.message);

    if (kind === 'collection' && desired.version === 3) {
      const previousTables = await resources({
        property: property('syncable-node-kind'),
        value: 'collection',
      });

      for (const previous of previousTables) {
        const config = stored<StoredSource>(
          previous,
          property('syncable-source-config'),
        );
        if (
          config?.version === 2 &&
          same(config.principal, desired.principal) &&
          (config.collection?.resource ?? config.navigation?.resource) ===
            desired.resource
        )
          throw new Error(
            'This entity type has older saved collections that need adoption before a shared table can be created. Existing data was retained.',
          );
      }
    }

    row = await store.newResource({
      parent,
      isA,
      propVals: {
        [core.name]: name,
        [core.localId]: 'syncables:node:' + encodeURIComponent(key),
        [property('syncable-source-key')]: key,
        [property('syncable-node-kind')]: kind,
        ...values,
      },
    });
    if (isA.includes(tableClass)) await ensureViews(row);

    return row;
  }

  async function transport(
    request: TransportRequest,
    connectionId = context.connectionId,
  ): Promise<TransportResponse> {
    if (context.principal?.kind === 'public') connectionId = undefined;
    const { url, method, body } = request;
    if (
      url.username ||
      url.password ||
      url.hash ||
      (method !== 'GET' && method !== 'POST')
    )
      throw new Error(
        'The catalog read is outside the supported request scope',
      );
    const query = Object.fromEntries(url.searchParams);
    if (Object.keys(query).length !== [...url.searchParams].length)
      throw new Error(
        'Repeated query parameters cannot be represented by this bridge',
      );
    const response = await store.proxy.request({
      platform: context.platform,
      ...(connectionId ? { connectionId } : {}),
      path: url.pathname.slice(1),
      method,
      query,
      ...(body !== undefined ? { body } : {}),
      ...(context.worker && request.purpose === 'list'
        ? { readProgress: 'page' }
        : {}),
    });

    if (request.purpose === 'principal' && response.status === 401)
      throw new PrincipalAuthorizationError(
        connectionId,
        (response.body as { error?: unknown } | null)?.error ===
          'credential_refresh_failed',
      );

    return {
      status: response.status,
      headers: response.headers,
      body: JSON.stringify(response.body),
    };
  }

  const rowClass = (collection: { resource: string }) => {
    const subject =
      context.apiSchema?.classes[ontologyShortname(collection.resource)];
    if (!subject) throw new Error('The catalog row schema is unavailable');

    return subject;
  };

  const apiBindings = new Map<string, Record<string, string>>();

  const apiProperties = (resource: string) => {
    if (!apiBindings.has(resource))
      apiBindings.set(resource, {
        ...context.apiSchema?.properties,
        ...context.apiSchema?.resourceProperties?.[resource],
      });

    return apiBindings.get(resource)!;
  };

  function collectionView(collection: EntityTypeDescription) {
    const columns = (collection.presentation?.columns ?? [])
      .flatMap(column => {
        const subject = apiProperties(collection.resource)[column.property];

        return subject
          ? [
              {
                property: subject,
                label: column.label,
                ...(column.labels
                  ? { format: 'enum', labels: column.labels }
                  : {}),
              },
            ]
          : [];
      })
      .slice(0, 40);

    return {
      version: 1,
      rowClass: rowClass(collection),
      title: collection.presentation.title,
      columns: columns.length
        ? columns
        : [{ property: core.name, label: 'Name' }],
      openTargetProperty: property('syncable-open-target'),
      ...(collection.relationships
        ? { relationships: collection.relationships }
        : {}),
    };
  }

  let types: EntityTypeDescription[] | undefined;
  const entityTypes = () => (types ??= describeEntityTypes(readDocument()));
  const resourceFields = new Map<string, ResourceFieldDescription[]>();

  const fieldsFor = (resource: string) => {
    if (!resourceFields.has(resource))
      resourceFields.set(
        resource,
        describeResourceFields(readDocument(), resource),
      );

    return resourceFields.get(resource)!;
  };

  const entityType = (resource: string) => {
    const found = entityTypes().find(item => item.resource === resource);
    if (!found) throw new Error('Unknown catalog entity type');

    return found;
  };

  async function ensureEntityTable({
    parent = root,
    principal = requirePrincipal(),
    connectionId = context.connectionId,
    resource,
  }: {
    parent?: string;
    principal?: SyncablePrincipal;
    connectionId?: string;
    resource: string;
  }) {
    const type = entityType(resource);
    const key = entityTableKey({ ...context, principal, resource });
    const adoptionRules = (context.flatAdoptionRules ?? []).filter(
      item => item.tableSourceKey === key,
    );

    if (adoptionRules.length) {
      const previous = await findNode(key, tableClass, 'collection');

      if (previous) {
        for (const rule of adoptionRules) {
          if (rule.definition.resource !== resource)
            throw new Error(
              'The adopted saved filter has a different resource type',
            );
          await ensureRule(previous, rule.definition, rule.label, key);
        }
      }
    }

    return ensureNode({
      key,
      kind: 'collection',
      parent,
      name: type.presentation.title,
      isA: [tableClass],
      values: {
        [core.classtype]: rowClass(type),
        [property('syncable-source-config')]: {
          version: 3,
          kind: 'collection',
          proxyOrigin: context.proxyOrigin,
          platform: context.platform,
          principal: principalIdentity(principal),
          resource,
          ...(principal.kind !== 'public' && connectionId
            ? { connectionId }
            : {}),
        },
        [property('syncable-collection-view')]: collectionView(type),
      },
    });
  }

  async function savedRules(table = root) {
    return (await resources({ property: core.parent, value: table })).filter(
      row =>
        row.hasClasses(viewClass) &&
        stored<StoredSource>(row, property('syncable-source-config'))?.kind ===
          'rule',
    );
  }

  async function ensureRule(
    table: AppResource,
    definition: ReadSelection,
    name?: string,
    tableSourceKey?: string,
  ) {
    compileReadSelection(readDocument(), definition, {
      querySelection: context.querySelection,
    });
    const ruleKey = readSelectionKey(definition);
    if (typeof ruleKey !== 'string' || !ruleKey)
      throw new Error('The catalog selection has no stable rule key');
    const key = ruleSourceKey(
      tableSourceKey ?? stored<string>(table, property('syncable-source-key'))!,
      ruleKey,
    );
    const rule = await ensureNode({
      key,
      kind: 'rule',
      parent: table.subject,
      name: name || entityType(definition.resource).presentation.title,
      isA: [viewClass],
      values: {
        [viewKind]: 'table',
        [property('syncable-source-config')]: {
          version: 3,
          kind: 'rule',
          resource: definition.resource,
          definition,
          ruleKey,
        },
      },
    });
    // The membership value is the saved View's actual subject, not its display name.
    await patch(rule, {
      [P + 'view-filters']: [
        {
          property: property('syncable-rule-memberships'),
          operator: 'eq',
          value: rule.subject,
        },
      ],
    });
    const views =
      stored<string[]>(await store.getResource(table.subject), tableViews) ??
      [];
    if (!views.includes(rule.subject))
      await patch(table, { [tableViews]: [...views, rule.subject] });

    return rule;
  }

  async function adoptFlatRows(
    principal: SyncablePrincipal,
    resource?: string,
  ) {
    for (const alias of context.flatIdentityAliases ?? []) {
      const config = alias.canonicalConfig as StoredRecordSource | undefined;
      if (
        !config ||
        config.kind !== 'record' ||
        (resource && config.resource !== resource) ||
        !same(config.principal, principal)
      )
        continue;
      if (
        (context.flatMigrationBlocks ?? []).some(
          block =>
            block.resource === config.resource &&
            same(block.principal, principal),
        )
      )
        continue;
      if (
        config.version !== 3 ||
        config.proxyOrigin !== context.proxyOrigin ||
        config.platform !== context.platform ||
        entitySourceKey({
          ...config,
          entityIdentity: config.entityIdentity,
        }) !== alias.canonicalSourceKey ||
        entityTableKey(config) !== alias.entityTableSourceKey
      )
        throw new Error(
          'The older row has no validated canonical entity identity',
        );
      const table = await findNode(
        alias.entityTableSourceKey!,
        tableClass,
        'collection',
      );
      if (!table)
        throw new Error('Adopt the entity collection before its saved rows');
      const row = await findNode(
        alias.canonicalSourceKey,
        rowClass(entityType(config.resource)),
        'record',
      );
      if (!row)
        throw new Error(
          'The older saved entity disappeared; no duplicate was created',
        );
      if (!(await withinRoot(row.subject))) continue;
      await updateNode(row, {
        key: alias.canonicalSourceKey,
        kind: 'record',
        parent: table.subject,
        isA: [rowClass(entityType(config.resource)), klass('syncable-record')],
        values: {
          [property('syncable-source-config')]: config,
          [property('syncable-entity-table')]: table.subject,
        },
      });
    }
  }

  async function discoverCollections(
    principalTable: AppResource,
    principal: SyncablePrincipal,
    connectionId?: string,
  ) {
    const created = [];

    const errors = [];

    for (const type of entityTypes()) {
      try {
        if (!type.collections.length) continue;
        if (
          principal.kind === 'public' &&
          !type.collections.some(collection => collection.allowsAnonymous)
        )
          continue;
        const table = await ensureEntityTable({
          parent: principalTable.subject,
          principal,
          connectionId,
          resource: type.resource,
        });
        created.push(table);

        for (const collection of type.collections) {
          if (
            collection.contextParams.length ||
            collection.relationships.length ||
            (principal.kind === 'public' && !collection.allowsAnonymous)
          )
            continue;
          const bound = bindCollection(readDocument(), {
            collection: collection.name,
            selection: context.querySelection,
          });
          await ensureRule(
            table,
            {
              version: 1,
              resource: type.resource,
              source: { kind: 'bound', bound },
            },
            collection.presentation.title,
          );
        }
      } catch (error) {
        errors.push(
          (type.presentation?.title ?? type.resource) + ': ' + messageOf(error),
        );
      }
    }

    try {
      await adoptFlatRows(principal);
    } catch (error) {
      errors.push(messageOf(error));
    }

    if (errors.length) throw new Error(errors.join('; ').slice(0, 2048));

    return created;
  }

  async function installedPrincipal(principal: SyncablePrincipal) {
    const matches = (context.principalApps ?? []).filter(ref =>
      same(ref.principal, principal),
    );
    if (matches.length > 1)
      throw new Error('The installed principal identity is ambiguous');
    if (!matches.length) return;
    const row = await store.getResource(matches[0].subject);
    const config = stored<StoredSource>(
      row,
      property('syncable-source-config'),
    );
    if (
      row.error ||
      !row.hasClasses(tableClass, klass('syncable-principal')) ||
      row.get(property('syncable-source-key')) !==
        identity({ kind: 'principal', principal }) ||
      config?.version !== 2 ||
      config.platform !== context.platform ||
      config.proxyOrigin !== context.proxyOrigin ||
      !same(config.principal, principal)
    )
      throw new Error('The saved principal App changed; reopen this service');

    return row;
  }

  async function openPrincipal(connectionId: string, navigate = true) {
    const principal = await resolveAuthenticatedPrincipal(readDocument(), {
      clientContext: context.clientContext,
      transport: request => transport(request, connectionId),
    });
    const durable = principalIdentity(principal);
    const installed = await installedPrincipal(durable);

    if (installed) {
      // Its connection binding is updated by the native open preparation step.
      if (navigate) await store.ui.openResource(installed.subject);

      return installed;
    }

    const key = identity({ kind: 'principal', principal: durable });
    const row = await ensureNode({
      key,
      kind: 'principal',
      parent: root,
      name: principal.claims.name ?? String(principal.subject),
      isA: [tableClass, klass('syncable-principal')],
      values: {
        [core.classtype]: tableClass,
        [property('syncable-source-config')]: {
          version: 2,
          proxyOrigin: context.proxyOrigin,
          platform: context.platform,
          principal: durable,
          connectionId,
        },
        [property('syncable-collection-view')]: {
          version: 1,
          rowClass: tableClass,
          title: 'Collections',
          columns: [{ property: core.name, label: 'Name' }],
        },
      },
    });
    if (await withinRoot(row.subject))
      await discoverCollections(row, durable, connectionId);
    if (navigate) await store.ui.openResource(row.subject);

    return row;
  }

  async function openPublic(navigate = true) {
    const principal: SyncablePrincipal = { kind: 'public' };
    const installed = await installedPrincipal(principal);

    if (installed) {
      if (navigate) await store.ui.openResource(installed.subject);

      return installed;
    }

    const row = await ensureNode({
      key: identity({ kind: 'principal', principal }),
      kind: 'principal',
      parent: root,
      name: 'Public',
      isA: [tableClass, klass('syncable-principal')],
      values: {
        [core.classtype]: tableClass,
        [property('syncable-source-config')]: {
          version: 2,
          proxyOrigin: context.proxyOrigin,
          platform: context.platform,
          principal,
        },
        [property('syncable-collection-view')]: {
          version: 1,
          rowClass: tableClass,
          title: 'Collections',
          columns: [{ property: core.name, label: 'Name' }],
        },
      },
    });
    if (await withinRoot(row.subject))
      await discoverCollections(row, principal, undefined);
    if (navigate) await store.ui.openResource(row.subject);

    return row;
  }

  async function createCollection(
    name: string,
    parameters: Record<string, string> = {},
    sourcePath?: string,
    filterName?: string,
  ) {
    if (!['principal', 'collection'].includes(context.kind))
      throw new Error('Choose a principal first');
    const collection = description(name);
    if (
      context.kind === 'collection' &&
      collection.resource !== context.resource
    )
      throw new Error('Choose a source for this entity collection');
    if (requirePrincipal().kind === 'public' && !collection.allowsAnonymous)
      throw new Error('This collection requires an authenticated principal');
    const doc = readDocument();
    const resolved = sourcePath
      ? await resolveCollectionNavigation(
          doc,
          bindCollectionNavigation(doc, {
            collection: name,
            sourcePath,
            context: parameters,
          }),
          { transport },
        )
      : undefined;
    const bound = bindCollection(doc, {
      collection: name,
      context: resolved?.pathParams ?? parameters,
      selection: context.querySelection,
    });
    const table =
      context.kind === 'collection'
        ? await store.getResource(root)
        : await ensureEntityTable({ resource: collection.resource });
    const rule = await ensureRule(
      table,
      {
        version: 1,
        resource: collection.resource,
        source: { kind: 'bound', bound },
      },
      filterName || collection.presentation.title,
    );
    // A fresh profile after navigation must see the table and its proven rows
    // on the same identity version; the old parent key cannot prove a v3 table.
    await adoptFlatRows(requirePrincipal(), collection.resource);
    await store.ui.openResource(rule.subject);

    return rule;
  }

  async function pickerRows(
    source: Pick<SyncablePickerSource, 'table' | 'resource'>,
  ): Promise<PickerRow[]> {
    if (!source.table) return [];
    const rows = await resources({
      property: property('syncable-entity-table'),
      value: source.table,
    });

    return rows.flatMap(row => {
      const origin = stored<StoredRecordSource>(
        row,
        property('syncable-source-config'),
      );
      const name = row.get(core.name);
      if (
        origin?.version !== 3 ||
        origin.kind !== 'record' ||
        origin.proxyOrigin !== context.proxyOrigin ||
        origin.platform !== context.platform ||
        !same(origin.principal, context.principal) ||
        row.get(property('syncable-entity-table')) !== source.table ||
        origin.resource !== source.resource ||
        origin.entityIdentity?.resource !== source.resource ||
        !origin.record ||
        typeof origin.record !== 'object' ||
        Array.isArray(origin.record) ||
        typeof name !== 'string' ||
        !name.trim()
      )
        return [];

      try {
        if (
          row.get(property('syncable-source-key')) === entitySourceKey(origin)
        )
          return [{ row, name, origin }];
      } catch {
        // Incomplete cached records are not selectable origins.
      }

      return [];
    });
  }

  function pickerDefinition(
    collection: CollectionDescription,
    origin: StoredRecordSource,
  ) {
    const reads = relatedCollectionReads(readDocument(), {
      resource: origin.resource,
      record: origin.record,
      context: origin.context as Record<string, string> | undefined,
    }).filter(read => read.collection === collection.name);
    if (reads.length !== 1) return;
    const [read] = reads;

    return relatedSelection(read, {
      entity: origin.entityIdentity,
      record: origin.record,
      context: origin.context ?? {},
      ...(origin.read ? { read: origin.read } : {}),
    });
  }

  async function createPickerCollection(
    name: string,
    source: SyncablePickerSource,
    choice: PickerRow,
    filterName?: string,
  ) {
    const collection = description(name);
    if (
      context.kind !== 'collection' ||
      collection.resource !== context.resource ||
      !source.collections.includes(name)
    )
      throw new Error('Choose a source for this entity collection');
    const current = await store.getResource(choice.row.subject);
    if (
      current.error ||
      current.get(property('syncable-entity-table')) !== source.table ||
      !same(
        stored<StoredSource>(current, property('syncable-source-config')),
        choice.origin,
      )
    )
      throw new Error(
        'The stored source changed. Open Sync again to reload it.',
      );
    const definition = pickerDefinition(collection, choice.origin);
    if (!definition)
      throw new Error('This record has no matching catalog read');
    const table = await store.getResource(root);
    const rule = await ensureRule(table, definition, filterName || choice.name);
    await adoptFlatRows(requirePrincipal(), collection.resource);
    await store.ui.openResource(rule.subject);

    return rule;
  }

  const statusSubject = () => context.rule?.subject ?? root;

  async function status(): Promise<SyncStatus> {
    const value = (await store.getResource(statusSubject())).get(
      property('syncable-mirror-status'),
    );

    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as SyncStatus)
      : {};
  }

  async function saveStatus(values: SyncStatus) {
    await patch(await store.getResource(statusSubject()), {
      [property('syncable-mirror-status')]: { ...(await status()), ...values },
    });
  }

  function runStamp() {
    const run = context.rule?.run;
    if (
      !run ||
      typeof run.generation !== 'string' ||
      typeof run.runId !== 'string' ||
      !Number.isSafeInteger(run.startOrder)
    )
      throw new Error('Start this saved filter through its Sync controls');

    return run;
  }

  async function assertRun() {
    const run = runStamp();
    const current = await status();
    if (
      current.paused ||
      current.run?.generation !== run.generation ||
      current.run?.runId !== run.runId
    )
      throw new Error('This saved filter run is no longer current');
    const selectedRule = context.rule;
    if (!selectedRule) throw new Error('Choose a saved filter to sync');
    const rule = await store.getResource(selectedRule.subject);
    const config = stored<StoredSource>(
      rule,
      property('syncable-source-config'),
    );
    if (
      config?.kind !== 'rule' ||
      config.ruleKey !== selectedRule.key ||
      readSelectionKey(config.definition) !== selectedRule.key
    )
      throw new Error('The saved filter definition changed');

    return run;
  }

  async function durableResource(
    kind: 'syncable-sync-run' | 'syncable-observation',
    parent: string,
    id: string,
    payload: DurableSyncRun | SyncObservation,
  ) {
    await assertRun();
    const existing = await resources({ property: core.localId, value: id });
    if (existing.length > 1)
      throw new Error('The durable sync evidence identity is ambiguous');

    if (existing.length) {
      if (!(await withinRoot(existing[0].subject)))
        throw new Error('The sync evidence moved outside this table');

      const previous = stored<DurableSyncRun>(existing[0], property(kind));
      if (kind === 'syncable-observation' && !same(previous, payload))
        throw new Error('The immutable entity observation changed');
      if (
        kind === 'syncable-sync-run' &&
        (previous?.complete || previous?.entityKeys?.length)
      )
        throw new Error('This sync run was already recorded');

      return existing[0];
    }

    return store.newResource({
      parent,
      isA: [klass(kind)],
      propVals: {
        [core.localId]: id,
        [property('syncable-node-kind')]: kind,
        [property(kind)]: payload,
      },
    });
  }

  async function ledger() {
    const runs: DurableSyncRun[] = [];
    const observations: SyncObservation[] = [];

    for (const rule of await savedRules()) {
      for (const row of await resources({
        property: core.parent,
        value: rule.subject,
      })) {
        const run = stored<DurableSyncRun>(row, property('syncable-sync-run'));
        if (run) runs.push(run);
        const observation = stored<SyncObservation>(
          row,
          property('syncable-observation'),
        );
        if (observation) observations.push(observation);
      }
    }

    return { runs, observations };
  }

  async function reconcile() {
    const evidence = await ledger();
    const state = reduceFlatState(evidence);
    const latest = new Map<
      string,
      { run: DurableSyncRun; observation: SyncObservation }
    >();
    const runs = new Map(evidence.runs.map(run => [run.runId, run]));

    for (const observation of evidence.observations) {
      const run = runs.get(observation.runId);
      if (!run || run.generation !== observation.generation) continue;
      const old = latest.get(observation.entityKey);
      if (
        !old ||
        old.run.startOrder < run.startOrder ||
        (old.run.startOrder === run.startOrder && old.run.runId < run.runId)
      )
        latest.set(observation.entityKey, { run, observation });
    }

    const counts: SyncCounts = { added: 0, changed: 0, unchanged: 0 };
    const resource = context.resource;
    if (!resource) throw new Error('Choose an entity collection first');
    const fullClass = rowClass(entityType(resource));
    const required =
      stored<string[]>(await store.getResource(fullClass), core.requires) ?? [];

    for (const [key, reduced] of Object.entries(state)) {
      await assertRun();
      const item = latest.get(key)?.observation;
      if (!item) continue;
      const old = await findNode(key, fullClass, 'record');
      const descriptors = fieldsFor(resource);
      const linkedFields = new Set(descriptors.map(field => field.property));
      const bindings = apiProperties(resource);
      const values = Object.fromEntries(
        Object.entries(reduced.values)
          .filter(([name]) => !linkedFields.has(name))
          .map(([name, value]) => {
            const subject = bindings[name];
            if (!subject)
              throw new Error('The catalog property schema is unavailable');

            return [subject, value];
          }),
      );
      const removed = reduced.cleared
        .map(name => bindings[name])
        .filter(Boolean);
      const diagnostics = [];
      const referenceRecord = structuredClone(reduced.raw ?? item.raw);

      for (const descriptor of descriptors) {
        const name = descriptor.property;
        if (
          !Object.hasOwn(reduced.values, name) &&
          !reduced.cleared.includes(name)
        )
          continue;
        const path = descriptor.field.split('.');
        let parent = referenceRecord;

        for (const part of path.slice(0, -1)) {
          if (
            !Object.hasOwn(parent, part) ||
            !parent[part] ||
            typeof parent[part] !== 'object' ||
            Array.isArray(parent[part])
          )
            Object.defineProperty(parent, part, {
              value: {},
              enumerable: true,
              writable: true,
              configurable: true,
            });
          parent = parent[part] as Values;
        }

        // The winning explicit field is authoritative. A changed owner must
        // never inherit a previous discriminator or ID from a merged snapshot.
        Object.defineProperty(parent, path[path.length - 1], {
          value: reduced.cleared.includes(name)
            ? null
            : structuredClone(reduced.values[name]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      // Targets are prepared natively from the real response journal. Reading
      // their exact canonical identities never grants this frame sibling writes.
      for (const descriptor of descriptors) {
        const resolution = resolveResourceField(
          readDocument(),
          descriptor,
          referenceRecord,
          item.context,
        );
        if (!resolution.present) continue;
        const subject = bindings[descriptor.property];
        if (!subject) throw new Error('The catalog link schema is unavailable');

        if (resolution.status !== 'resolved') {
          removed.push(subject);
          diagnostics.push(
            ...resolution.diagnostics.map(diagnostic => ({
              field: descriptor.field,
              ...diagnostic,
            })),
          );
          continue;
        }

        if (resolution.original === null) {
          removed.push(subject);
          continue;
        }

        const targets = [];

        for (const target of resolution.objects) {
          const targetKey = entitySourceKey({
            ...context,
            principal: requirePrincipal(),
            entityIdentity: target.entity,
          });
          const row = await findNode(
            targetKey,
            rowClass({ resource: target.resource }),
            'record',
          );
          if (!row) break;
          targets.push(row.subject);
        }

        if (
          targets.length === resolution.objects.length &&
          (descriptor.cardinality === 'many' || targets.length === 1)
        )
          values[subject] =
            descriptor.cardinality === 'many' ? targets : targets[0];
        else {
          removed.push(subject);
          diagnostics.push({
            field: descriptor.field,
            message: 'The linked record is not available in this drive.',
          });
        }
      }

      const recordConfig: StoredRecordSource = {
        version: 3,
        kind: 'record',
        proxyOrigin: context.proxyOrigin,
        platform: context.platform,
        principal: requirePrincipal(),
        resource: resource,
        entityIdentity: item.entity,
        record: referenceRecord,
        context: item.context,
        read: item.provenance.read,
        managedProperties: Object.keys(values),
      };
      const intents = relatedCollectionReads(readDocument(), {
        resource: resource,
        record: referenceRecord,
        context: item.provenance.read.pathParams,
      }).map(navigation => ({
        version: 1,
        resource: navigation.resource,
        sourceEntityKey: key,
        label: description(navigation.collection).presentation.title,
        definition: relatedSelection(navigation, {
          entity: item.entity,
          record: referenceRecord,
          context: item.context,
          read: item.provenance.read,
        }),
      }));
      let name = item.projected.name;

      if (name === item.projected.id) {
        const label = entityType(resource).presentation.columns.find(
          column =>
            typeof reduced.values[column.property] === 'string' &&
            (reduced.values[column.property] as string).trim(),
        );
        if (label) name = reduced.values[label.property] as string;
      }

      const rowValues: Values = {
        [core.name]: name,
        ...values,
        [property('syncable-entity-table')]: root,
        [property('syncable-rule-memberships')]: reduced.memberships,
        [property('syncable-source-config')]: recordConfig,
        [property('syncable-navigation-intents')]: intents,
        ...(context.schema?.properties['syncable-reference-diagnostics']
          ? {
              [property('syncable-reference-diagnostics')]: diagnostics.slice(
                0,
                100,
              ),
            }
          : {}),
      };
      const complete = required.every(subject => {
        const value = Object.hasOwn(rowValues, subject)
          ? rowValues[subject]
          : old?.get(subject);

        return (
          !removed.includes(subject) && value !== undefined && value !== null
        );
      });
      const rowClasses = [
        ...(complete || old?.hasClasses(fullClass)
          ? [fullClass]
          : [klass('syncable-reference')]),
        klass('syncable-record'),
      ];

      if (old) {
        if (!(await withinRoot(old.subject))) {
          counts.protected = (counts.protected ?? 0) + 1;
          continue;
        }

        counts[
          (await updateNode(
            old,
            {
              key,
              kind: 'record',
              isA: rowClasses,
              values: rowValues,
            },
            removed,
          ))
            ? 'changed'
            : 'unchanged'
        ]++;
      } else {
        await ensureNode({
          key,
          kind: 'record',
          parent: root,
          name,
          isA: rowClasses,
          values: rowValues,
        });
        counts.added++;
      }
    }

    return counts;
  }

  async function refresh() {
    if (context.kind !== 'collection' || !context.rule)
      throw new Error('Choose a saved filter to sync');
    await assertRun();
    const stamp = runStamp();
    const rule = context.rule;
    let run: DurableSyncRun = {
      ruleSubject: rule.subject,
      ruleKey: rule.key,
      ...stamp,
      complete: false,
      entityKeys: [],
    };
    const id =
      'syncables:run:' + sourceConfigFingerprint([rule.subject, stamp.runId]);
    const storedRun = await durableResource(
      'syncable-sync-run',
      rule.subject,
      id,
      run,
    );

    try {
      const result = await readSelection(readDocument(), rule.definition, {
        transport,
        querySelection: context.querySelection,
        maxPartitions: 32,
        limits: {
          maxRequests: 128,
          maxRecords: 4000,
          // Responses include native journal validation and linked-record
          // storage, so this bounds that work as well as provider latency.
          timeoutMs: 300000,
          maxRetries: 0,
        },
      });
      await assertRun();
      const accepted = result.observations.map(observation => ({
        ...observation,
        entityKey: entitySourceKey({
          ...context,
          principal: requirePrincipal(),
          entityIdentity: observation.entity,
        }),
        ruleKey: rule.key,
        ...stamp,
      }));
      if (
        accepted.some(
          observation => observation.entity.resource !== context.resource,
        )
      )
        throw new Error('The read returned a different entity type');
      for (const observation of accepted)
        await durableResource(
          'syncable-observation',
          rule.subject,
          'syncables:observation:' +
            sourceConfigFingerprint([
              rule.subject,
              stamp.runId,
              observation.entityKey,
              observation.representationKey,
              observation.partitionKey,
            ]),
          observation,
        );
      run = {
        ...run,
        entityKeys: [
          ...new Set(accepted.map(observation => observation.entityKey)),
        ],
      };
      await patch(storedRun, { [property('syncable-sync-run')]: run });
      const counts = await reconcile();
      await assertRun();

      if (result.complete) {
        run = { ...run, complete: true };
        await patch(storedRun, { [property('syncable-sync-run')]: run });
        await reconcile();
      }

      const summary = {
        ...counts,
        rows: run.entityKeys.length,
        incomplete: !result.complete,
        error:
          [
            ...result.errors,
            ...(counts.protected
              ? [
                  'Moved cached rows were retained; open their current location to update them.',
                ]
              : []),
          ]
            .join('; ')
            .slice(0, 1024) || null,
      };
      await saveStatus({
        ...summary,
        ...(result.complete ? { lastSuccess: new Date().toISOString() } : {}),
      });

      return summary;
    } catch (error) {
      await assertRun()
        .then(() => saveStatus({ error: messageOf(error).slice(0, 1024) }))
        .catch(() => undefined);
      throw error;
    }
  }

  async function storedPrincipals() {
    const saved = (
      await resources({ property: core.parent, value: root })
    ).filter(row => row.hasClasses(klass('syncable-principal')));

    for (const ref of context.principalApps ?? []) {
      const row = await installedPrincipal(ref.principal);
      if (!row) continue;

      // Pending setup rows are retained; the registered App is the displayed choice.
      for (let i = saved.length - 1; i >= 0; i--) {
        const config = stored<StoredSource>(
          saved[i],
          property('syncable-source-config'),
        );
        if (
          same(
            config?.kind === 'rule' ? undefined : config?.principal,
            ref.principal,
          )
        )
          saved.splice(i, 1);
      }

      saved.push(row);
    }

    return saved;
  }

  async function discoverPrincipals() {
    const connections = await store.proxy.connections({
      platform: context.platform,
    });
    const saved = await storedPrincipals();
    const known = new Set<string | undefined>();
    const errors = [];
    const authorizationRequired = [];

    for (const row of saved) {
      const config = stored<StoredSource>(
        row,
        property('syncable-source-config'),
      );
      if (config?.version !== 2 || config.principal?.kind !== 'authenticated')
        continue;
      known.add(config.connectionId);
      if (
        (context.principalApps ?? []).some(ref => ref.subject === row.subject)
      )
        continue;

      try {
        await findNode(
          identity({ kind: 'principal', principal: config.principal }),
          tableClass,
          'principal',
        );
        if (await withinRoot(row.subject))
          await discoverCollections(row, config.principal, config.connectionId);
      } catch (error) {
        errors.push(error);
      }
    }

    for (const connection of connections) {
      if (known.has(connection.connectionId)) continue;

      try {
        await openPrincipal(connection.connectionId, false);
      } catch (error) {
        if (error instanceof PrincipalAuthorizationError)
          authorizationRequired.push({ ...connection, error });
        else errors.push(error);
      }
    }

    return { connections, authorizationRequired, errors };
  }

  return {
    refresh,
    status,
    saveStatus,
    openPrincipal,
    openPublic,
    createCollection,
    createPickerCollection,
    pickerRows,
    pickerDefinition,
    availableCollections: () =>
      descriptions().filter(
        collection =>
          context.principal?.kind !== 'public' || collection.allowsAnonymous,
      ),
    ensureEntityTable,
    ensureRule,
    savedRules,
    storedPrincipals,
    discoverPrincipals,
  };
}

function el<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  text?: unknown,
  className?: string,
) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;

  return node;
}

function mountStoredSourcePicker({
  app,
  store,
  context,
  collection,
  source,
  inputs,
  save,
  showError,
}: {
  app: ReturnType<typeof createSyncApp>;
  store: SyncAppStore;
  context: SyncAppViewContext;
  collection: CollectionDescription;
  source: SyncablePickerSource;
  inputs: HTMLDivElement;
  save: HTMLButtonElement;
  showError: (reason: unknown) => void;
}) {
  const groups = (source.groups ?? []).map(group => ({
    ...group,
    select: el('select'),
  }));
  const select = el('select');
  const status = el('p', 'Loading saved sources…', 'muted');
  status.setAttribute('role', 'status');

  const field = (title: string, control: HTMLSelectElement) => {
    const label = el('label', title);
    control.setAttribute('aria-label', title);
    label.append(control);
    inputs.append(label);
  };

  for (const group of groups) field(group.title, group.select);
  field(source.title, select);
  inputs.append(status);

  const setOptions = (
    control: HTMLSelectElement,
    placeholder: string,
    options: PickerRow[],
  ) => {
    const previous = control.value;
    const first = el('option', placeholder);
    first.value = '';
    control.replaceChildren(
      first,
      ...options.map(({ row, name }) => {
        const option = el('option', name);
        option.value = row.subject;

        return option;
      }),
    );
    if (options.some(({ row }) => row.subject === previous))
      control.value = previous;
    control.disabled = options.length === 0;
  };

  const ruleSubjects = [
    ...new Set([
      ...source.ruleSubjects,
      ...groups.flatMap(group => group.ruleSubjects),
    ]),
  ];
  let options: PickerRow[] = [];
  let choices: PickerRow[] = [];
  let disposed = false;
  let changed = false;
  let pending: Promise<void> | undefined;
  const selected = () =>
    choices.find(({ row }) => row.subject === select.value);

  const filter = () => {
    choices = options.filter(({ row }) =>
      groups.every(group => {
        if (!group.select.value) return true;
        const linked = row.get(group.property);

        return Array.isArray(linked)
          ? linked.includes(group.select.value)
          : linked === group.select.value;
      }),
    );
    setOptions(select, 'Select one', choices);
    save.disabled = !selected();
  };

  for (const group of groups) {
    setOptions(group.select, 'All', []);
    group.select.addEventListener('change', filter);
  }

  select.addEventListener('change', () => {
    save.disabled = !selected();
  });
  filter();

  const byName = (a: PickerRow, b: PickerRow) => a.name.localeCompare(b.name);

  const refresh = () => {
    changed = true;
    if (pending || disposed) return;
    pending = (async () => {
      while (changed && !disposed) {
        changed = false;
        const [rows, groupRows, rules] = await Promise.all([
          app.pickerRows(source),
          Promise.all(groups.map(group => app.pickerRows(group))),
          store.getMany(ruleSubjects),
        ]);
        if (disposed) return;
        const eligible = rows.filter(({ origin }) =>
          app.pickerDefinition(collection, origin),
        );
        const counts = new Map<string, number>();
        for (const { name } of eligible)
          counts.set(name, (counts.get(name) ?? 0) + 1);
        const groupNames = new Map(
          groupRows.flat().map(({ row, name }) => [row.subject, name]),
        );
        options = eligible
          .map(choice => {
            if (counts.get(choice.name) === 1) return choice;
            const groupName = groups
              .map(group => {
                const subject = choice.row.get(group.property);

                return typeof subject === 'string'
                  ? groupNames.get(subject)
                  : undefined;
              })
              .find(Boolean);

            return {
              ...choice,
              name: `${choice.name} · ${groupName ?? choice.origin.entityIdentity.path}`,
            };
          })
          .sort(byName);
        for (const [index, group] of groups.entries())
          setOptions(group.select, 'All', groupRows[index].sort(byName));
        filter();

        const states = rules.map(rule => {
          if (!readable(rule)) throw new Error(rule.error);

          return stored<SyncStatus>(
            rule,
            context.schema.properties['syncable-mirror-status'],
          );
        });
        status.textContent = states.some(state => state?.error)
          ? 'A source sync needs attention. Open its Sync tab to retry.'
          : states.some(
                state =>
                  !state?.lastSuccess &&
                  !state?.paused &&
                  state?.enabled !== false,
              )
            ? 'Fetching sources in the background. You can choose from the records already stored.'
            : options.length
              ? ''
              : 'No saved records are available for this source yet.';
        status.hidden = !status.textContent;
      }
    })()
      .catch(error => {
        if (!disposed) showError(error);
      })
      .finally(() => {
        pending = undefined;
        if (changed) refresh();
      });
  };

  const subscriptions = ruleSubjects.map(subject =>
    store.subscribe?.(subject, refresh),
  );
  refresh();

  return {
    source,
    selected,
    dispose: () => {
      disposed = true;
      for (const unsubscribe of subscriptions) unsubscribe?.();
    },
  };
}

/** The visible controls read saved state. Accepted executions run separately. */
export async function view({
  root,
  store,
}: {
  root: HTMLElement;
  store: SyncAppStore;
}) {
  const context = await store.getContext();
  const app = createSyncApp(store, context);

  if (context.worker) {
    await store.execution('state');
    await app.refresh();

    return;
  }

  const style = document.createElement('style');
  style.textContent =
    ':root{font-family:"Open Sans","Segoe UI",sans-serif;color-scheme:light dark}body{margin:0;font-size:14px}#root{padding:12px 0}.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px}button,input,select{font:inherit;padding:7px 12px;border:1px solid #aaa;border-radius:8px;color:inherit;background:transparent}button{cursor:pointer}button:disabled{opacity:.55}.muted{color:#777}.error{padding:12px;border:1px solid #c66;border-radius:8px}label{display:flex;gap:8px;align-items:center;margin:8px 0}';
  document.head.append(style);

  const showError = (reason: unknown) => {
    root.querySelector('[data-sync-error]')?.remove();
    const message = el('p', messageOf(reason), 'error');
    message.setAttribute('role', 'alert');
    message.setAttribute('data-sync-error', '');
    root.prepend(message);
  };

  const button = (label: unknown, action: () => unknown) => {
    const node = el('button', label);
    node.addEventListener('click', async () => {
      node.disabled = true;

      try {
        await action();
      } catch (error) {
        showError(error);
      } finally {
        node.disabled = false;
      }
    });

    return node;
  };

  const controls = el('div', undefined, 'controls');
  const warnings = () =>
    (context.adoptionWarnings ?? [])
      .filter(message => typeof message === 'string')
      .slice(0, 20)
      .map(message => {
        const node = el('p', message.slice(0, 2048), 'muted');
        node.setAttribute('role', 'status');

        return node;
      });

  if (context.kind === 'platform') {
    let discovery:
      | Awaited<ReturnType<typeof app.discoverPrincipals>>
      | undefined;
    const errors = [];

    if (context.preferredConnectionId) {
      try {
        await app.openPrincipal(context.preferredConnectionId);

        return;
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      discovery = await app.discoverPrincipals();
      errors.push(...discovery.errors);
    } catch (error) {
      errors.push(error);
    }

    try {
      await app.openPublic(false);
    } catch (error) {
      errors.push(error);
    }

    const principals = await app.storedPrincipals();
    const hasPublic = principals.some(
      principal =>
        stored<SyncableSourceConfig>(
          principal,
          context.schema.properties['syncable-source-config'],
        )?.principal?.kind === 'public',
    );

    const connect = async (connectionId?: string) => {
      const result = await store.proxy.connect({
        platform: context.platform,
        ...(connectionId ? { connectionId } : {}),
      });
      if (result?.status === 'connected')
        await app.openPrincipal(result.connectionId);
    };

    root.append(el('h3', 'Connected principals'));
    controls.append(button('Connect account', () => connect()));
    if (!hasPublic) controls.append(button('Public', () => app.openPublic()));
    root.append(controls);
    for (const principal of principals)
      root.append(
        button(principal.get(core.name), () =>
          store.ui.openResource(principal.subject),
        ),
      );
    if (
      discovery?.connections.length === 0 &&
      principals.every(
        principal =>
          stored<SyncableSourceConfig>(
            principal,
            context.schema.properties['syncable-source-config'],
          )?.principal?.kind === 'public',
      )
    )
      root.append(el('p', 'No accounts connected yet.', 'muted'));

    for (const connection of discovery?.authorizationRequired ?? []) {
      const notice = el('section', undefined, 'error');
      notice.setAttribute('role', 'alert');
      notice.append(
        el('h4', connection.label || 'Connection needs attention'),
        el('p', connection.error.message),
        el('p', 'Saved accounts and collections are retained.', 'muted'),
        button(
          connection.canReconnect === true
            ? 'Reconnect connection'
            : 'Connect account again',
          () =>
            connect(
              connection.canReconnect === true
                ? connection.connectionId
                : undefined,
            ),
        ),
      );
      root.append(notice);
    }

    root.append(...warnings());
    if (errors.length)
      showError(
        new Error(
          errors
            .map(error => messageOf(error))
            .join('; ')
            .slice(0, 1024),
        ),
      );

    return;
  }

  if (
    context.kind === 'principal' ||
    (context.kind === 'collection' && !context.rule)
  ) {
    if (context.kind === 'collection' && !context.resource) {
      root.append(el('h3', 'Saved filter sync'));
      root.append(
        el(
          'p',
          'Open the principal App to choose a source for this saved collection.',
          'muted',
        ),
      );
      root.append(
        button('Open principal', async () =>
          store.ui.openResource(
            stored<string>(
              await store.getResource(context.subject),
              core.parent,
            )!,
          ),
        ),
      );
      root.append(...warnings());

      return;
    }

    const collectionView = context.kind === 'collection';
    const picker = el('div');
    picker.append(
      el('h3', collectionView ? 'Set sync scope' : 'Save a filter'),
    );
    const filterName = el('input');
    filterName.setAttribute('aria-label', 'Filter name');
    filterName.placeholder = collectionView
      ? 'Filter name (optional)'
      : 'Filter name';
    const select = el('select');
    select.setAttribute('aria-label', 'Source collection');
    const inputs = el('div');
    const definitions = app
      .availableCollections()
      .filter(item => !context.resource || item.resource === context.resource);
    const entrypoint = el('select');
    entrypoint.setAttribute('aria-label', 'Source');
    const sourceControls = el('div');
    const advanced = el('details');
    advanced.append(el('summary', 'Advanced source options'));

    if (!definitions.length) {
      picker.append(
        el(
          'p',
          'No catalog sources are available for this collection.',
          'muted',
        ),
      );
      root.append(picker, ...warnings());

      return;
    }

    if (collectionView) {
      picker.append(
        el('p', 'Save a filter to set what this table syncs.', 'muted'),
      );
      select.hidden = definitions.length === 1;
    }

    for (const collection of definitions) {
      const option = el(
        'option',
        collection.presentation?.title ?? collection.name,
      );
      option.value = collection.name;
      select.append(option);
    }

    const selectedDefinition = () =>
      definitions.find(item => item.name === select.value);
    const selectedEntrypoints = () =>
      (selectedDefinition()?.entrypoints ?? []).filter(
        source =>
          context.principal?.kind !== 'public' || source.allowsAnonymous,
      );

    let storedPicker: ReturnType<typeof mountStoredSourcePicker> | undefined;
    const sourceType = el('select');
    sourceType.setAttribute('aria-label', 'Source record type');

    const renderInputs = () => {
      storedPicker?.dispose();
      storedPicker = undefined;
      inputs.replaceChildren();
      const definition = selectedDefinition();
      const storedSources = (context.pickerSources ?? []).filter(
        source => definition && source.collections.includes(definition.name),
      );
      sourceControls.hidden =
        !selectedEntrypoints().length || storedSources.length > 0;

      if (definition && storedSources.length) {
        if (storedSources.length > 1) {
          const previous = sourceType.value;
          sourceType.replaceChildren(
            ...storedSources.map(source => {
              const option = el('option', source.title);
              option.value = source.resource;

              return option;
            }),
          );
          if (storedSources.some(source => source.resource === previous))
            sourceType.value = previous;
          inputs.append(sourceType);
        }

        storedPicker = mountStoredSourcePicker({
          app,
          store,
          context,
          collection: definition,
          source:
            storedSources.find(
              source => source.resource === sourceType.value,
            ) ?? storedSources[0],
          inputs,
          save,
          showError,
        });

        return;
      }

      save.disabled = false;
      const source = selectedEntrypoints().find(
        item => item.sourcePath === entrypoint.value,
      );

      for (const parameter of source?.inputs ??
        selectedDefinition()?.inputs ??
        []) {
        const label = el('label', parameter.title ?? parameter.name);
        const input = el('input');
        input.name = parameter.name;
        input.required = parameter.required;
        input.setAttribute('aria-label', parameter.title ?? parameter.name);
        if (parameter.description) input.title = parameter.description;
        label.append(input);
        inputs.append(label);
      }
    };

    const renderEntrypoints = () => {
      entrypoint.replaceChildren();
      const sources = selectedEntrypoints();

      for (const source of sources) {
        const option = el('option', source.sourcePath);
        option.value = source.sourcePath;
        entrypoint.append(option);
      }

      const direct = el('option', 'Collection parameters');
      direct.value = '';
      entrypoint.append(direct);
      const advancedOnly = collectionView && sources.length === 1;

      if (advancedOnly) {
        advanced.open = false;
        advanced.append(entrypoint);
      }

      sourceControls.replaceChildren(advancedOnly ? advanced : entrypoint);
      renderInputs();
    };

    select.addEventListener('change', renderEntrypoints);
    entrypoint.addEventListener('change', renderInputs);
    sourceType.addEventListener('change', renderInputs);
    const save = button('Save filter', () => {
      if (storedPicker) {
        const choice = storedPicker.selected();
        if (choice)
          return app.createPickerCollection(
            select.value,
            storedPicker.source,
            choice,
            filterName.value.trim(),
          );

        return;
      }

      const parameters = [...inputs.querySelectorAll('input')];

      for (const input of parameters) {
        if (!input.reportValidity()) return;
      }

      const values = Object.fromEntries(
        parameters.map(input => [input.name, input.value.trim()]),
      );
      const name =
        filterName.value.trim() ||
        (collectionView ? Object.values(values).join(' / ') : undefined);

      return app.createCollection(
        select.value,
        values,
        entrypoint.value || undefined,
        name || undefined,
      );
    });

    if (collectionView) {
      controls.append(filterName, save);
      picker.append(select, inputs, controls, sourceControls);
    } else {
      controls.append(filterName, select, sourceControls, save);
      picker.append(controls, inputs);
    }

    root.append(picker, ...warnings());
    renderEntrypoints();

    return;
  }

  if (!context.rule) throw new Error('Choose a saved filter to sync');
  const selected = await store.getResource(context.rule.subject);
  const start = button('Sync now', async () => {
    await store.execution('start');
    void render().catch(showError);
  });
  const pause = button('Pause', async () => {
    const { paused } = await app.status();
    if (!paused) await store.execution('cancel');
    await app.saveStatus({ paused: !paused });
    void render().catch(showError);
  });
  const pageProgress = el('p', undefined, 'muted');
  pageProgress.setAttribute('role', 'status');
  pageProgress.hidden = true;
  const details = el('div');
  controls.append(start, pause);
  if (context.connectionId)
    controls.append(
      button('Reconnect', () =>
        store.proxy.connect({
          platform: context.platform,
          connectionId: context.connectionId,
        }),
      ),
    );
  root.append(
    el('h3', 'Saved filter sync'),
    el('p', selected.get(core.name)),
    controls,
    pageProgress,
    details,
    ...warnings(),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  let rendering = 0;
  let previousDetails: string | undefined;

  const render = async () => {
    clearTimeout(timer);
    const revision = ++rendering;
    const execution = await store.execution('state');
    const status = await app.status();
    if (revision !== rendering) return;
    const startText = execution.queued
      ? 'Queued'
      : execution.running
        ? 'Syncing'
        : 'Sync now';
    if (start.textContent !== startText) start.textContent = startText;
    start.disabled = !!(
      execution.running ||
      execution.queued ||
      status.paused ||
      status.enabled === false
    );
    const pauseText = status.paused ? 'Resume' : 'Pause';
    if (pause.textContent !== pauseText) pause.textContent = pauseText;
    const progress = execution.running && execution.progress;
    const pageText = progress
      ? `Syncing page ${progress.page}${progress.total ? ` of ${progress.total}` : ''}`
      : '';
    pageProgress.hidden = !pageText;
    if (pageProgress.textContent !== pageText)
      pageProgress.textContent = pageText;

    const detailsStamp = JSON.stringify([
      status.rows,
      status.lastSuccess,
      status.incomplete,
      status.added,
      status.changed,
      status.unchanged,
      status.error,
    ]);

    if (detailsStamp !== previousDetails) {
      previousDetails = detailsStamp;
      details.replaceChildren();
      if (typeof status.rows === 'number')
        details.append(
          el(
            'p',
            status.rows + ' entries read in the last attempt for this filter',
          ),
        );
      details.append(
        el(
          'p',
          status.lastSuccess
            ? 'Last completed sync for this filter: ' + status.lastSuccess
            : 'This filter has not completed a sync yet. Existing rows may come from another filter or an earlier import.',
          'muted',
        ),
      );
      if (status.lastSuccess || status.incomplete)
        details.append(
          el(
            'p',
            `${status.added ?? 0} added · ${status.changed ?? 0} changed · ${status.unchanged ?? 0} unchanged`,
            'muted',
          ),
        );
      if (status.error) showError(status.error);
      else root.querySelector('[data-sync-error]')?.remove();
    }

    if (execution.running || execution.queued)
      timer = setTimeout(() => void render().catch(showError), 500);
  };

  await render();
}
