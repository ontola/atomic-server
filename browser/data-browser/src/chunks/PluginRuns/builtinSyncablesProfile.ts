// @wc-ignore-file
import {
  bindCollection,
  describeCollections,
  describeAuthenticatedPrincipals,
  relatedCollectionReads,
  resolveAuthenticatedPrincipal,
  resolveCollectionNavigation,
  validateCollectionRead,
  validateCollectionEntryRead,
  validateCollectionNavigationRead,
  validatePrincipalRead,
  compileReadSelection,
  describeEntityTypes,
  type CompiledReadSelection,
  type EntityObservation,
  type OpenApiDocument,
  type BoundCollection,
  type CollectionNavigation,
  type QuerySelection,
  type TransportRequest,
  type TransportResponse,
} from 'syncables/browser';
import {
  canonicalValue,
  collectionIdentity,
  principalIdentity,
  sourceConfigFingerprint,
  type SyncablePrincipal,
} from './builtinSyncIdentity.js';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
  type SyncableSourceKey,
  type LegacySyncableSourceKey,
} from './syncableSource';
import {
  core,
  canonicalizeScheme,
  dataBrowser,
  CollectionBuilder,
  isAtomicIdentifier,
  ensureSchema,
  findSchema,
  subjectsReferToSameResource,
  type Store,
} from '@tomic/lib';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import {
  ProxyConnections,
  readLimitedResponseText,
  type ProxyHost,
  type ConnectionPrincipal,
} from '@helpers/proxyConnections';
import {
  isSyncableResourceInDrive,
  syncablePlatformSchema,
  platformLocalId,
} from './syncablePlatform';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  findRegisteredSyncablePrincipalApp,
  isSyncablePrincipalApp,
  listSyncablePrincipalApps,
} from './syncablePrincipalApp';
import {
  resolveSyncableRule,
  type ResolvedSyncableRule,
  type SyncableRuleContext,
} from './syncableRules';
import type { SyncableApiSchema } from './syncableApiSchema';

export interface TrustedSyncableCatalog {
  document: OpenApiDocument;
  querySelection?: QuerySelection;
}
export interface SyncAppContext {
  subject: string;
  drive: string;
  platform: string;
  proxyOrigin: string;
  kind: 'platform' | 'principal' | 'collection' | 'legacy';
  resource?: string;
  rule?: SyncableRuleContext;
  mode?: 'public';
  principal?: SyncablePrincipal;
  connectionId?: string;
  /** Native binding owner; stored collection identity does not depend on its slot. */
  principalApp?: string;
  collection?: BoundCollection;
  navigation?: CollectionNavigation;
  sourceKey?: string;
  parentRecord?: {
    resource: string;
    record: Record<string, unknown>;
    context?: Record<string, string>;
    identity: SyncableSourceKey;
  };
  legacySource?: LegacySyncableSourceKey;
  document?: unknown;
  querySelection?: QuerySelection;
  apiSchema?: SyncableApiSchema;
  selection?: string;
  clientContext?: string;
  worker?: boolean;
  proxyTransport: 'host';
  schema: {
    classes: Record<string, string>;
    properties: Record<string, string>;
  };
}

const provenanceGuards = new WeakMap<SyncAppContext, () => void>();
const resolvedRules = new WeakMap<SyncAppContext, ResolvedSyncableRule>();
const compiledRules = new WeakMap<SyncAppContext, CompiledReadSelection>();

/** Host-only dependency guard, including delayed Atomic writes after a provider reply. */
export function assertSyncAppContext(context: SyncAppContext): void {
  provenanceGuards.get(context)?.();
}

/** Revoke accepted work when the existing stored-source proof becomes stale. */
export function subscribeSyncAppContext(
  context: SyncAppContext,
  onInvalidated: () => void,
): () => void {
  return resolvedRules.get(context)?.subscribe(onInvalidated) ?? (() => {});
}

/** Host-resolved origins must stay unchanged while their selected read is active. */
export function syncAppOriginEntityKeys(
  context: SyncAppContext,
): readonly string[] {
  return (
    resolvedRules.get(context)?.origins.map(origin => origin.entity.key) ?? []
  );
}

/** Revalidate the selected drive without yielding between authority and mutation.
 * Check parents too: moving an ancestor can leave a descendant's drive stamp stale. */
export function assertSyncAppDrive(
  store: Pick<Store, 'resources' | 'normalizeSubject'>,
  drive: string,
  subject: string,
): void {
  const trash = store.resources
    .get(store.normalizeSubject(drive))
    ?.get(dataBrowser.properties.trashFolder);
  const seen = new Set<string>();
  let current = subject;

  while (seen.size < 64 && !seen.has(current)) {
    if (
      typeof trash === 'string' &&
      subjectsReferToSameResource(current, trash)
    )
      throw new Error(
        'This integration is in Trash. Restore it before syncing.',
      );
    if (subjectsReferToSameResource(current, drive)) return;
    seen.add(current);
    const resource = store.resources.get(store.normalizeSubject(current));
    if (!resource || resource.error) break;
    const assignedDrive = resource.get(
      'https://atomicdata.dev/properties/drive',
    );

    if (
      assignedDrive !== undefined &&
      (typeof assignedDrive !== 'string' ||
        !subjectsReferToSameResource(assignedDrive, drive))
    )
      break;

    const parent = resource.get(core.properties.parent);
    if (typeof parent !== 'string' || !parent) break;
    current = parent;
  }

  throw new Error('The Sync table is no longer in the selected drive');
}

/** Capture the ACL ancestry already loaded by canWrite so a delayed native
 * projection cannot outlive its original write authorization. */
export function captureSyncAppWriteScope(
  store: Pick<Store, 'resources' | 'normalizeSubject'>,
  subjects: readonly string[],
): () => void {
  const fields = (subject: string) => {
    const row = store.resources.get(subject);
    if (!row || row.error) return;
    const parent = row.get(core.properties.parent);
    const write = row.get(core.properties.write);
    const grants =
      Array.isArray(write) && write.every(grant => typeof grant === 'string')
        ? [...new Set(write.map(canonicalizeScheme))].sort()
        : write;

    return {
      parent:
        typeof parent === 'string' ? store.normalizeSubject(parent) : parent,
      proof: sourceConfigFingerprint([parent, grants]),
    };
  };

  const expected = new Map<string, string>();

  for (const start of subjects) {
    let subject: string | undefined = store.normalizeSubject(start);

    while (subject && !expected.has(subject)) {
      const values = fields(subject);
      if (!values) break;
      if (expected.size >= 128)
        throw new Error('The Sync write ancestry exceeds its limit');
      expected.set(subject, values.proof);
      subject = typeof values.parent === 'string' ? values.parent : undefined;
    }
  }

  return () => {
    for (const [subject, proof] of expected)
      if (fields(subject)?.proof !== proof)
        throw new Error('Write access to this Sync source changed');
  };
}

/** Load full ancestry once, including stamped rows, for the synchronous guard. */
async function cacheSyncAppDrive(store: Store, drive: string, subject: string) {
  const root = await store.getResource(drive);
  if (root.error) throw root.error;
  const trash = root.get(dataBrowser.properties.trashFolder);
  const seen = new Set<string>();
  let current = subject;

  while (seen.size < 64 && !seen.has(current)) {
    if (
      typeof trash === 'string' &&
      subjectsReferToSameResource(current, trash)
    )
      throw new Error(
        'This integration is in Trash. Restore it before syncing.',
      );
    if (subjectsReferToSameResource(current, drive)) return;
    seen.add(current);
    const resource = await store.getResource(current);
    if (resource.error) throw resource.error;
    const parent = resource.get(core.properties.parent);
    if (typeof parent !== 'string' || !parent) break;
    current = parent;
  }

  throw new Error('The Sync table is outside the selected drive');
}

/** Public source fields are context, never additional write authority. */
export async function syncAppContext(
  store: Store,
  drive: string,
  table: string,
  initialize = false,
  selection?: string,
  ruleSubject?: string,
): Promise<SyncAppContext> {
  if (!(await isSyncableResourceInDrive(store, drive, table)))
    throw new Error('This Sync table is outside the selected drive');
  await cacheSyncAppDrive(store, drive, table);
  const resolve = initialize ? ensureSchema : findSchema;
  const p = await resolve(store, drive, syncablePlatformSchema());
  const h = await resolve(store, drive, syncableHierarchySchema());
  const resource = await store.getResource(table);
  if (resource.error) throw resource.error;
  const platform =
    p.properties?.['syncable-platform-id'] &&
    resource.get(p.properties['syncable-platform-id']);
  const proxyOrigin =
    p.properties?.['syncable-proxy-origin'] &&
    resource.get(p.properties['syncable-proxy-origin']);
  const context = {
    subject: table,
    drive,
    proxyTransport: 'host',
    schema: {
      classes: { ...p.classes, ...h.classes },
      properties: { ...p.properties, ...h.properties },
    },
  } as const;

  const sourceProperty = h.properties?.['syncable-source-key'];
  const configProperty = h.properties?.['syncable-source-config'];
  const raw = sourceProperty && resource.get(sourceProperty);

  // Principal Apps retain provider branding metadata as well as their source.
  // An existing source must be validated before considering the setup context.
  if (
    typeof platform === 'string' &&
    typeof proxyOrigin === 'string' &&
    raw === undefined
  ) {
    if (ruleSubject)
      throw new Error('Select a filter from an entity collection');
    platformLocalId(proxyOrigin, platform);
    if (proxyOrigin !== getIntegrationProxy())
      throw new Error(
        'Select this integration proxy in Settings before syncing',
      );

    return { ...context, platform, proxyOrigin, kind: 'platform' };
  }

  const key = parseSyncableSourceKey(raw);
  if (
    (platform !== undefined && platform !== key.platform) ||
    (proxyOrigin !== undefined && proxyOrigin !== key.proxyOrigin)
  )
    throw new Error('The App metadata does not match its source identity');
  if (key.proxyOrigin !== getIntegrationProxy())
    throw new Error('Select this integration proxy in Settings before syncing');
  if (key.version === 1)
    return {
      ...context,
      platform: key.platform,
      proxyOrigin: key.proxyOrigin,
      kind: 'legacy',
      legacySource: key,
    };
  const config = parseSyncableSourceConfig(
    configProperty && resource.get(configProperty),
  );
  if (typeof raw !== 'string' || !sourceConfigMatchesKey(config, key, raw))
    throw new Error(
      'The Sync configuration does not match its source identity',
    );
  if (key.kind === 'record')
    throw new Error('Open a collection to sync its records');
  if (
    key.version === 2 &&
    key.kind === 'collection' &&
    !config.collection &&
    !config.navigation
  )
    throw new Error('The collection has no saved binding');
  const result: SyncAppContext = {
    ...context,
    platform: key.platform,
    proxyOrigin: key.proxyOrigin,
    kind: key.kind,
    principal: config.principal,
    connectionId: config.connectionId,
    collection: config.collection,
    navigation: config.navigation,
    sourceKey: raw,
    ...(config.version === 3 ? { resource: config.resource } : {}),
    ...(config.principal.kind === 'public' ? { mode: 'public' } : {}),
    ...(config.principal.kind === 'authenticated' &&
    config.principal.clientContext
      ? { clientContext: config.principal.clientContext }
      : {}),
  };

  const actor = store.getAgent?.()?.subject;
  const currentServer = store.getServerUrl?.();
  const sourceStamp = () =>
    JSON.stringify([
      resource.get(sourceProperty!),
      resource.get(configProperty!),
    ]);
  const savedSourceStamp = sourceStamp();

  const assertSourceCurrent = () => {
    if (
      store.getAgent?.()?.subject !== actor ||
      store.getServerUrl?.() !== currentServer ||
      resource.error ||
      sourceStamp() !== savedSourceStamp
    )
      throw new Error(
        'The Sync source or account changed; reopen this collection',
      );
  };

  provenanceGuards.set(result, assertSourceCurrent);

  const bindPrincipalApp = async () => {
    if (key.kind !== 'collection') return result;
    let registered = await findRegisteredSyncablePrincipalApp(store, {
      drive,
      proxyOrigin: key.proxyOrigin,
      platform: key.platform,
      principal: config.principal,
      assertCurrent: assertSourceCurrent,
    });

    // A same-drive move is allowed even if the drive index was lost. The actual
    // ancestor App is still a validated binding owner; metadata alone is not.
    if (!registered) {
      let parent = resource.get(core.properties.parent);
      const seen = new Set<string>();

      while (
        typeof parent === 'string' &&
        !seen.has(parent) &&
        seen.size < 64 &&
        !subjectsReferToSameResource(parent, drive)
      ) {
        seen.add(parent);
        const candidate = await store.getResource(parent);
        const candidateRaw = candidate.get(sourceProperty!);

        if (
          candidateRaw !== undefined &&
          (await isSyncablePrincipalApp(store, drive, candidate))
        ) {
          const candidateConfig = parseSyncableSourceConfig(
            candidate.get(configProperty!),
          );

          if (
            candidateConfig.proxyOrigin === key.proxyOrigin &&
            candidateConfig.platform === key.platform &&
            same(candidateConfig.principal, config.principal)
          ) {
            registered = {
              subject: candidate.subject,
              principal: candidateConfig.principal,
              name: String(candidate.get(core.properties.name) ?? key.platform),
              ...(candidateConfig.connectionId
                ? { connectionId: candidateConfig.connectionId }
                : {}),
            };
            break;
          }
        }

        parent = candidate.get(core.properties.parent);
      }
    }

    if (
      !registered &&
      typeof store.fetchResourceFromServer === 'function' &&
      !store.noServer
    ) {
      const matches = await listSyncablePrincipalApps(store, {
        drive,
        proxyOrigin: key.proxyOrigin,
        platform: key.platform,
        principal: config.principal,
        assertCurrent: assertSourceCurrent,
      });
      if (matches.length > 1)
        throw new Error('The principal App identity is ambiguous');
      registered = matches[0];
    }

    assertSourceCurrent();
    if (!registered) return result;
    const principalApp = await store.getResource(registered.subject);
    await cacheSyncAppDrive(store, drive, registered.subject);
    const stamp = () =>
      JSON.stringify([
        principalApp.get(sourceProperty!),
        principalApp.get(configProperty!),
        principalApp.get(core.properties.isA),
        principalApp.get(p.properties!['builtin-app']),
        principalApp.get(p.properties!['syncable-platform-id']),
        principalApp.get(p.properties!['syncable-proxy-origin']),
      ]);
    const saved = stamp();
    const previous = provenanceGuards.get(result);
    provenanceGuards.set(result, () => {
      previous?.();
      assertSyncAppDrive(store, drive, principalApp.subject);
      if (stamp() !== saved)
        throw new Error(
          'The principal App connection changed; reopen this collection',
        );
    });
    result.principalApp = principalApp.subject;
    result.connectionId = registered.connectionId;

    return result;
  };

  if (key.version === 3) {
    if (config.version !== 3 || config.kind !== 'collection')
      throw new Error('Open a canonical entity collection');

    if (ruleSubject) {
      const tableStamp = JSON.stringify([
        resource.get(sourceProperty!),
        resource.get(configProperty!),
      ]);

      const assertTable = () => {
        assertSyncAppDrive(store, drive, table);
        if (
          JSON.stringify([
            resource.get(sourceProperty!),
            resource.get(configProperty!),
          ]) !== tableStamp
        )
          throw new Error('The entity collection source changed');
      };

      const resolved = await resolveSyncableRule(store, {
        drive,
        table,
        subject: ruleSubject,
        proxyOrigin: config.proxyOrigin,
        platform: config.platform,
        principal: config.principal,
        resource: config.resource,
        properties: context.schema.properties,
        assertCurrent: assertTable,
        assertDrive: subject => assertSyncAppDrive(store, drive, subject),
      });
      result.rule = {
        subject: resolved.subject,
        key: resolved.key,
        resource: resolved.resource,
        definition: resolved.definition,
      };
      resolvedRules.set(result, resolved);
      provenanceGuards.set(result, () => {
        assertSourceCurrent();
        resolved.assertCurrent();
      });
    }

    return bindPrincipalApp();
  }

  if (ruleSubject)
    throw new Error('This source does not own the selected Sync filter');

  if (config.version === 2 && config.navigation) {
    if (!config.parentSourceKey || !sourceProperty)
      throw new Error('The collection has no source record identity');
    const row = await findSourceRecord(
      store,
      drive,
      sourceProperty,
      h.properties?.['syncable-resource-index'],
      config.parentSourceKey,
      resource.get(core.properties.parent),
    );
    const rowKeyRaw = sourceProperty && row.get(sourceProperty);
    const rowKey = parseSyncableSourceKey(rowKeyRaw);
    const rowConfig = parseSyncableSourceConfig(
      configProperty && row.get(configProperty),
    );
    if (
      rowKey.version !== 2 ||
      rowConfig.version !== 2 ||
      rowKey.kind !== 'record' ||
      typeof rowKeyRaw !== 'string' ||
      config.parentSourceKey !== rowKeyRaw ||
      !sourceConfigMatchesKey(rowConfig, rowKey, rowKeyRaw) ||
      !rowConfig.record ||
      !rowConfig.resource ||
      rowConfig.proxyOrigin !== config.proxyOrigin ||
      rowConfig.platform !== config.platform ||
      !same(rowConfig.principal, config.principal) ||
      rowConfig.connectionId !== config.connectionId
    )
      throw new Error(
        'The collection navigation has a different source record',
      );
    const stamp = () =>
      JSON.stringify([row.get(sourceProperty), row.get(configProperty!)]);
    const savedStamp = stamp();
    provenanceGuards.set(result, () => {
      assertSourceCurrent();
      assertSyncAppDrive(store, drive, row.subject);
      if (stamp() !== savedStamp)
        throw new Error('The collection source record changed');
    });
    result.parentRecord = {
      resource: rowConfig.resource,
      record: rowConfig.record,
      context: rowConfig.context,
      identity: rowKey,
    };
  }

  if (selection) {
    const row = await store.getResource(selection);
    if (
      row.error ||
      !subjectsReferToSameResource(row.get(core.properties.parent), table)
    )
      throw new Error('Select a record from this collection');
    result.selection = selection;
  }

  return bindPrincipalApp();
}

async function findSourceRecord(
  store: Store,
  drive: string,
  property: string,
  indexProperty: string | undefined,
  key: string,
  currentParent: unknown,
) {
  const safe = (subject: string) => {
    if (isAtomicIdentifier(subject)) return true;

    try {
      const url = new URL(subject);

      return (
        url.origin === new URL(store.getServerUrl()).origin &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    } catch {
      return false;
    }
  };

  const root = await store.getResource(drive);
  const rawIndex = indexProperty && root.get(indexProperty);
  const indexed =
    rawIndex && typeof rawIndex === 'object' && !Array.isArray(rawIndex)
      ? (rawIndex as Record<string, unknown>)[key]
      : undefined;
  const candidates = new Set<string>();
  if (typeof indexed === 'string' && safe(indexed)) candidates.add(indexed);
  if (typeof currentParent === 'string' && safe(currentParent))
    candidates.add(currentParent);

  for (const candidate of candidates) {
    if (!(await isSyncableResourceInDrive(store, drive, candidate))) continue;
    const resource = await store.getResource(candidate);
    if (!resource.error && resource.get(property) === key) return resource;
  }

  const collection = new CollectionBuilder(store)
    .setDrive(drive)
    .setProperty(property)
    .setValue(key)
    .setPageSize(2)
    .build();
  await collection.waitForReady();
  if (collection.totalMembers !== 1)
    throw new Error('Unknown or ambiguous source record identity');
  const subject = await collection.getMemberWithIndex(0);
  if (
    !subject ||
    !safe(subject) ||
    !(await isSyncableResourceInDrive(store, drive, subject))
  )
    throw new Error('The source record is outside the selected drive');
  const resource = await store.getResource(subject);
  if (resource.error || resource.get(property) !== key)
    throw new Error('The source record identity changed');

  return resource;
}

const same = (left: unknown, right: unknown) =>
  JSON.stringify(canonicalValue(left)) ===
  JSON.stringify(canonicalValue(right));

/** Recompute saved descriptors from the configured proxy's current declarations. */
export function canonicalSyncAppContext(
  context: SyncAppContext,
  trusted: TrustedSyncableCatalog,
): SyncAppContext {
  assertSyncAppContext(context);
  if (context.kind !== 'collection') return context;

  const scoped = (updates: Partial<SyncAppContext>) => {
    const result = { ...context, ...updates };
    const guard = provenanceGuards.get(context);
    if (guard) provenanceGuards.set(result, guard);
    const rule = resolvedRules.get(context);
    if (rule) resolvedRules.set(result, rule);

    return result;
  };

  const { document, querySelection } = trusted;

  if (context.resource) {
    const definitions = describeEntityTypes(document).filter(
      item => item.resource === context.resource,
    );
    if (definitions.length !== 1)
      throw new Error('Unknown or ambiguous canonical entity resource');
    if (!context.rule) return context;
    const resolved = resolvedRules.get(context);
    const compiled = compileReadSelection(document, context.rule.definition, {
      origins: resolved?.origins,
      querySelection,
      maxPartitions: 32,
      publicOnly: context.principal?.kind === 'public',
    });
    if (
      compiled.resource !== context.resource ||
      compiled.key !== context.rule.key
    )
      throw new Error(
        'The selected Sync filter does not match this entity collection',
      );
    const result = scoped({
      rule: { ...context.rule, definition: compiled.selection },
    });
    compiledRules.set(result, compiled);

    return result;
  }

  const saved = context.collection ?? context.navigation;
  if (!saved) throw new Error('The collection has no saved binding');
  const definitions = describeCollections(document).filter(
    item => item.name === saved.collection,
  );
  const definition = definitions[0];
  if (
    definitions.length !== 1 ||
    !definition ||
    definition.resource !== saved.resource ||
    (context.principal?.kind === 'public' && !definition.allowsAnonymous)
  )
    throw new Error(
      'This principal cannot read the selected catalog collection',
    );

  if (context.navigation) {
    const parent = context.parentRecord;
    if (!parent) throw new Error('The collection has no source record');
    const identityCollection = parent.identity.collection;
    const parentDefinition = describeCollections(document).find(
      item =>
        item.name === identityCollection?.name &&
        item.resource === parent.resource,
    );
    if (
      !parentDefinition ||
      parent.record[parentDefinition.idField] !== parent.identity.remoteId
    )
      throw new Error(
        'The source record identity does not match its saved data',
      );
    const candidates = relatedCollectionReads(document, parent).filter(
      candidate =>
        same(
          collectionIdentity(undefined, candidate),
          collectionIdentity(undefined, context.navigation),
        ),
    );
    if (candidates.length !== 1)
      throw new Error('Unknown or ambiguous declared collection navigation');

    return scoped({ navigation: candidates[0], collection: undefined });
  }

  const collection = bindCollection(document, {
    collection: context.collection!.collection,
    context: context.collection!.pathParams,
    selection: querySelection,
  });

  return scoped({ collection });
}

/** Native-only evidence from an actual catalog-declared principal response. */
export interface VerifiedSyncablePrincipal {
  connectionId: string;
  principal: Extract<SyncablePrincipal, { kind: 'authenticated' }>;
  activeId: string;
}

/** Credentials remain in the shared keyed proxy client. The frame selects no authority. */
export function syncProxyTransport(
  proxy: ProxyConnections,
  originalContext: SyncAppContext,
  assertSessionCurrent: () => void,
  trusted: TrustedSyncableCatalog,
  assertProviderReadAllowed: () => void = () => undefined,
  onPrincipalVerified?: (
    proof: VerifiedSyncablePrincipal,
  ) => void | Promise<void>,
  onObserved?: (observations: readonly EntityObservation[]) => Promise<void>,
  onPage?: (request: TransportRequest, response?: TransportResponse) => void,
): ProxyHost {
  const assertCurrent = () => {
    assertSessionCurrent();
    assertSyncAppContext(originalContext);
  };

  assertCurrent();

  const assertReadCurrent = () => {
    assertCurrent();
    assertProviderReadAllowed();
  };

  const context = canonicalSyncAppContext(originalContext, trusted);
  const { document } = trusted;
  const servers = document.servers as { url?: unknown }[] | undefined;
  const server = new URL(
    typeof servers?.[0]?.url === 'string' ? servers[0].url : '',
  );
  if (
    server.protocol !== 'https:' ||
    server.username ||
    server.password ||
    server.search ||
    server.hash
  )
    throw new Error('The catalog must declare a fixed HTTPS API server');
  let selected = context.collection;
  let providerReads = 0;
  const verifications = new Map<string, Promise<{ active: string }>>();
  const principalSelection =
    context.principal?.kind === 'authenticated'
      ? { namespace: context.principal.namespace }
      : {};
  const descriptions = describeAuthenticatedPrincipals(document);
  const collectionEntrypoints =
    context.kind === 'collection' && context.resource && !context.rule
      ? describeCollections(document).filter(
          collection =>
            collection.resource === context.resource &&
            collection.entrypoints.length > 0,
        )
      : [];

  const relay = async (
    request: TransportRequest,
    slot: string | undefined,
    signal?: AbortSignal,
    expectedActive?: string,
  ): Promise<TransportResponse> => {
    assertReadCurrent();
    signal?.throwIfAborted();
    if (++providerReads > 64)
      throw new Error('The integration read budget was exceeded');

    if (context.principal?.kind === 'public') {
      if (slot !== undefined)
        throw new Error('Public collections cannot use credentials');
      const response = await fetch(request.url, {
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/json',
          ...(request.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
      });
      const body = await readLimitedResponseText(response, 'Integration');
      const headers: Record<string, string> = {};

      for (const name of ['link', 'retry-after', 'etag', 'content-type']) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }

      assertReadCurrent();
      signal?.throwIfAborted();

      return { status: response.status, headers, body };
    }

    if (!slot) throw new Error('Wrong integration account');
    const active = await proxy.activeKeyedConnection(context.platform, slot);
    assertReadCurrent();
    signal?.throwIfAborted();
    if (expectedActive !== undefined && active !== expectedActive)
      throw new Error(
        'The integration connection changed after identity verification',
      );
    const target = new URL(
      '/proxy/' +
        encodeURIComponent(active) +
        '/' +
        context.platform +
        request.url.pathname,
      context.proxyOrigin,
    );
    target.search = request.url.search;
    const response = await proxy.readKeyed(target, signal, {
      method: request.method as 'GET' | 'POST',
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    if ((await proxy.activeKeyedConnection(context.platform, slot)) !== active)
      throw new Error(
        'The integration connection changed during the provider read',
      );
    assertReadCurrent();
    signal?.throwIfAborted();

    return { ...response, body: JSON.stringify(response.body) };
  };

  const remember = async (
    slot: string,
    operationId: string,
    response: TransportResponse,
    request: TransportRequest,
    activeId: string,
  ) => {
    const resolved = await resolveAuthenticatedPrincipal(document, {
      operationId,
      ...principalSelection,
      clientContext: context.clientContext,
      transport: async expected => {
        if (
          expected.url.href !== request.url.href ||
          expected.method !== request.method
        )
          throw new Error('Invalid principal response provenance');

        return response;
      },
    });
    const principal = principalIdentity(resolved);
    if (context.principal && !same(principal, context.principal))
      throw new Error(
        'This connection belongs to a different authenticated principal',
      );
    assertReadCurrent();
    if (
      (await proxy.activeKeyedConnection(context.platform, slot)) !== activeId
    )
      throw new Error(
        'The integration connection changed after identity verification',
      );
    assertReadCurrent();
    await proxy.rememberKeyedPrincipal(
      context.platform,
      slot,
      principal as ConnectionPrincipal,
      operationId,
    );
    assertReadCurrent();
    if (
      (await proxy.activeKeyedConnection(context.platform, slot)) !== activeId
    )
      throw new Error(
        'The integration connection changed after identity verification',
      );
    assertReadCurrent();
    await onPrincipalVerified?.({
      connectionId: slot,
      principal: principal as Extract<
        SyncablePrincipal,
        { kind: 'authenticated' }
      >,
      activeId,
    });
    assertReadCurrent();
    if (
      (await proxy.activeKeyedConnection(context.platform, slot)) !== activeId
    )
      throw new Error(
        'The integration connection changed after identity verification',
      );
    assertReadCurrent();
  };

  const verify = async (slot: string, signal?: AbortSignal) => {
    const active = await proxy.activeKeyedConnection(context.platform, slot);
    assertReadCurrent();
    const existing = verifications.get(slot);
    if (existing && (await existing).active === active) return active;
    const pending = (async () => {
      const matches = descriptions.filter(
        item =>
          !principalSelection.namespace ||
          item.namespace === principalSelection.namespace,
      );
      if (matches.length !== 1)
        throw new Error('Unknown or ambiguous authenticated principal');
      const descriptor = matches[0]!;
      let actual: TransportRequest | undefined;
      let response: TransportResponse | undefined;
      await resolveAuthenticatedPrincipal(document, {
        operationId: descriptor.operationId,
        ...principalSelection,
        clientContext: context.clientContext,
        transport: async request => {
          actual = request;
          response = await relay(request, slot, signal, active);

          return response;
        },
      });
      if (!actual || !response)
        throw new Error('Principal verification was not completed');
      await remember(slot, descriptor.operationId, response, actual, active);

      return { active };
    })();
    verifications.set(slot, pending);

    try {
      return (await pending).active;
    } catch (error) {
      if (verifications.get(slot) === pending) verifications.delete(slot);
      throw error;
    }
  };

  return {
    origin: context.proxyOrigin,
    capability: async () => {
      throw new Error('This app uses host-held connection keys');
    },
    connections: async platform => {
      assertCurrent();
      if (platform !== context.platform)
        throw new Error('Wrong integration platform');
      if (context.principal?.kind === 'public') return [];
      const rows = await proxy.listKeyed(platform);
      assertCurrent();

      const connections = await Promise.all(
        rows
          .filter(
            row =>
              context.kind === 'platform' ||
              row.connection_id === context.connectionId,
          )
          .map(async row => ({
            connectionId: row.connection_id,
            platform,
            ...(typeof row.label === 'string' && row.label.trim()
              ? {
                  label: row.label
                    .replace(/\p{Cc}/gu, '')
                    .trim()
                    .slice(0, 120),
                }
              : {}),
            canReconnect: await proxy.canReconnectKeyed(
              platform,
              row.connection_id,
            ),
          })),
      );
      assertCurrent();

      return connections;
    },
    request: async (input, signal) => {
      assertReadCurrent();
      signal?.throwIfAborted();
      if (context.kind === 'legacy')
        throw new Error('Open the provider App to upgrade this legacy source');
      if (
        input.platform !== context.platform ||
        input.ifMatch !== undefined ||
        (input.method !== undefined &&
          !['GET', 'POST'].includes(input.method)) ||
        (input.body !== undefined && typeof input.body !== 'string') ||
        typeof input.path !== 'string' ||
        input.path.includes('?') ||
        input.path.includes('#') ||
        input.path.includes('\\')
      )
        throw new Error('Only the selected catalog read is available');
      const url = new URL('/' + input.path.replace(/^\//, ''), server.origin);
      if (
        url.origin !== server.origin ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== '/' + input.path.replace(/^\//, '')
      )
        throw new Error('Invalid provider path');
      if (
        input.query !== undefined &&
        (!input.query ||
          typeof input.query !== 'object' ||
          Array.isArray(input.query))
      )
        throw new Error('Invalid provider query');

      for (const [name, value] of Object.entries(
        (input.query as Record<string, unknown>) ?? {},
      )) {
        if (
          !['string', 'number', 'boolean'].includes(typeof value) ||
          (typeof value === 'number' && !Number.isFinite(value))
        )
          throw new Error('Invalid provider query');
        url.searchParams.set(name, String(value));
      }

      const request: TransportRequest = {
        url,
        method: (input.method ?? 'GET') as 'GET' | 'POST',
        headers: {},
        ...(input.body === undefined ? {} : { body: input.body }),
      };
      const publicSource = context.principal?.kind === 'public';
      const slot =
        context.kind === 'platform' ? input.connectionId : context.connectionId;
      if (
        publicSource
          ? input.connectionId !== undefined
          : !slot || input.connectionId !== slot
      )
        throw new Error('Wrong integration account');
      const descriptor =
        !publicSource &&
        descriptions.find(item =>
          validatePrincipalRead(document, request, {
            operationId: item.operationId,
            ...principalSelection,
          }),
        );

      if (descriptor) {
        if (context.kind === 'platform') {
          const known = await proxy.listKeyed(context.platform);
          assertReadCurrent();
          if (!known.some(row => row.connection_id === slot))
            throw new Error('Unknown keyed integration connection');
        }

        const active = await proxy.activeKeyedConnection(
          context.platform,
          slot!,
        );
        assertReadCurrent();
        const response = await relay(request, slot, signal, active);
        if (response.status >= 200 && response.status < 300)
          await remember(
            slot!,
            descriptor.operationId,
            response,
            request,
            active,
          );
        assertReadCurrent();
        signal?.throwIfAborted();

        return {
          status: response.status,
          headers: response.headers,
          text: response.body,
        };
      }

      if (
        (context.kind === 'principal' &&
          validateCollectionEntryRead(document, request, {
            publicOnly: publicSource,
          })) ||
        collectionEntrypoints.some(
          collection =>
            (!publicSource || collection.allowsAnonymous) &&
            validateCollectionEntryRead(document, request, {
              collection: collection.name,
              publicOnly: publicSource,
            }),
        )
      ) {
        const verifiedActive = !publicSource
          ? await verify(slot!, signal)
          : undefined;
        assertReadCurrent();
        signal?.throwIfAborted();
        const response = await relay(request, slot, signal, verifiedActive);
        assertReadCurrent();
        signal?.throwIfAborted();

        return {
          status: response.status,
          headers: response.headers,
          text: response.body,
        };
      }

      if (context.kind !== 'collection')
        throw new Error('This source cannot read that endpoint');

      if (context.resource) {
        const plan = compiledRules.get(context);
        if (!context.rule || !plan || !plan.allows(request))
          throw new Error('This filter cannot read that endpoint');
        const verifiedActive = !publicSource
          ? await verify(slot!, signal)
          : undefined;
        assertReadCurrent();
        signal?.throwIfAborted();
        const reportPage = input.readProgress === 'page' ? onPage : undefined;
        reportPage?.(request);
        const response = await relay(request, slot, signal, verifiedActive);
        assertReadCurrent();
        signal?.throwIfAborted();
        reportPage?.(request, response);
        const observations = await plan.observe(request, response);
        assertReadCurrent();
        signal?.throwIfAborted();
        // Native storage consumes the host-held response journal. The frame
        // cannot submit evidence or extend its selected-table write root.
        if (observations.length) await onObserved?.(observations);
        assertReadCurrent();
        signal?.throwIfAborted();

        return {
          status: response.status,
          headers: response.headers,
          text: response.body,
        };
      }

      const navigationRead =
        context.navigation &&
        validateCollectionNavigationRead(document, context.navigation, request);
      const collectionRead =
        selected && validateCollectionRead(document, selected, request);
      if (!navigationRead && !collectionRead)
        throw new Error('This source cannot read that endpoint');

      if (
        publicSource &&
        navigationRead &&
        context.navigation?.kind === 'responseLink'
      ) {
        const security =
          document.paths[context.navigation.source.template]?.get?.security ??
          document.security;
        if (
          Array.isArray(security) &&
          security.length &&
          security.every(
            entry =>
              entry && typeof entry === 'object' && Object.keys(entry).length,
          )
        )
          throw new Error(
            'Public navigation cannot read an authenticated operation',
          );
      }

      const verifiedActive = !publicSource
        ? await verify(slot!, signal)
        : undefined;
      assertReadCurrent();
      signal?.throwIfAborted();
      const response = await relay(request, slot, signal, verifiedActive);

      if (navigationRead && response.status >= 200 && response.status < 300) {
        selected = await resolveCollectionNavigation(
          document,
          context.navigation!,
          {
            transport: async expected => {
              if (
                expected.url.href !== request.url.href ||
                expected.method !== request.method
              )
                throw new Error('Invalid navigation response provenance');

              return response;
            },
          },
        );
        selected = bindCollection(document, {
          collection: selected.collection,
          context: selected.pathParams,
          selection: trusted.querySelection,
        });
      }

      assertReadCurrent();
      signal?.throwIfAborted();

      return {
        status: response.status,
        headers: response.headers,
        text: response.body,
      };
    },
  };
}
