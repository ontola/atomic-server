import { useEffect, useState } from 'react';
import {
  CollectionBuilder,
  core,
  dataBrowser,
  findSchema,
  isAtomicIdentifier,
  pluginSchema,
  subjectsReferToSameResource,
} from '@tomic/lib';
import {
  prepareDocument,
  describeCollections,
  describeAuthenticatedPrincipals,
  type QuerySelection,
} from 'syncables/browser';
import {
  useCurrentAgent,
  useServerURL,
  useStore,
  type Store,
} from '@tomic/react';
import {
  getIntegrationProxy,
  useIntegrationProxy,
} from '@helpers/integrationProxy';
import { AtomicLink } from '@components/AtomicLink';
import {
  findSyncablePlatform,
  isSyncableResourceInDrive,
  classifySyncableResourceDrive,
} from './syncablePlatform';
import {
  ensureSyncablePrincipalApp,
  listSyncablePrincipalApps,
  type SyncablePrincipalAppRef,
} from './syncablePrincipalApp';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
} from './syncableSource';
import { collectSyncableLegacySources } from './syncableLegacy';
import {
  collectSyncableFlatAdoption,
  unsupportedLegacyFlatBlocks,
} from './syncableFlatAdoption';
import { ProxyConnections } from '@helpers/proxyConnections';
import { AppFrame, type AppFrameProfile } from '@chunks/AppPage/AppFrame';
import {
  useAppExecutions,
  type AppExecutionRegistry,
  type AppExecutionSpec,
} from '@chunks/AppPage/AppExecutionRuntime';
import { ShowRoute } from '../../routes/ShowRoute';
import { fetchSyncableDocument } from './syncableDocument';
import { syncableApiSchema } from './syncableApiSchema';
import {
  ruleSourceKey,
  sourceConfigFingerprint,
  canonicalValue,
} from './builtinSyncIdentity.js';
import {
  parseSyncableRuleConfig,
  readSyncableRuleStatus,
  type SyncableRuleRun,
} from './syncableRules';
import {
  assertSyncAppDrive,
  assertSyncAppContext,
  canonicalSyncAppContext,
  syncAppContext,
  syncProxyTransport,
  type SyncAppContext,
  type TrustedSyncableCatalog,
  type VerifiedSyncablePrincipal,
} from './builtinSyncablesProfile';

// @wc-ignore
/** Native installation preparation; frame metadata never establishes identity proof. */
export async function prepareSyncablePrincipalAppOpen(
  {
    store,
    drive,
    setup,
    context,
    trusted,
    proxy,
    verified,
    principalApps,
    assertCurrent,
  }: {
    store: Store;
    drive: string;
    setup: string;
    context: SyncAppContext;
    trusted: TrustedSyncableCatalog;
    proxy: ProxyConnections;
    verified: Map<string, VerifiedSyncablePrincipal>;
    principalApps: readonly SyncablePrincipalAppRef[];
    assertCurrent: () => void;
  },
  subject: string,
): Promise<string> {
  assertCurrent();

  if (!isAtomicIdentifier(subject)) {
    const target = new URL(subject);
    if (
      target.origin !== new URL(store.getServerUrl()).origin ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new Error('A principal App must belong to the selected server');
  }

  const row = await store.getResource(subject);
  assertCurrent();
  const p = context.schema.properties;
  const raw = row.get(p['syncable-source-key']);
  if (raw === undefined) return subject;
  const key = parseSyncableSourceKey(raw);
  if (key.version !== 2 || key.kind !== 'principal') return subject;
  const config = parseSyncableSourceConfig(
    row.get(p['syncable-source-config']),
  );
  if (
    config.version !== 2 ||
    typeof raw !== 'string' ||
    !sourceConfigMatchesKey(config, key, raw) ||
    config.proxyOrigin !== context.proxyOrigin ||
    config.platform !== context.platform
  )
    throw new Error('The chosen principal does not belong to this integration');
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
  const preferred = await proxy.preferredKeyedConnection(
    { drive, app: setup },
    context.platform,
  );
  assertCurrent();
  const preferredProof = preferred ? verified.get(preferred) : undefined;
  const observed =
    preferredProof && same(preferredProof.principal, config.principal)
      ? preferredProof
      : config.connectionId
        ? verified.get(config.connectionId)
        : undefined;
  if (observed && !same(observed.principal, config.principal))
    throw new Error('The observed connection belongs to a different principal');
  const existing = principalApps.find(
    ref =>
      subjectsReferToSameResource(ref.subject, subject) &&
      same(ref.principal, config.principal),
  );

  if (
    existing &&
    !(preferredProof && same(preferredProof.principal, config.principal))
  ) {
    // Already installed resources may be browsed from cached data, without OAuth
    // or a provider refresh. The native registry validates this readonly lookup.
    const current = await listSyncablePrincipalApps(store, {
      drive,
      platform: context.platform,
      proxyOrigin: context.proxyOrigin,
      principal: config.principal,
      assertCurrent,
    });
    assertCurrent();
    if (
      !current.some(
        ref =>
          subjectsReferToSameResource(ref.subject, subject) &&
          same(ref.principal, config.principal),
      )
    )
      throw new Error('The saved principal App changed; reopen this service');

    return subject;
  }

  let connectionId: string | undefined;

  if (config.principal.kind === 'public') {
    const collections = describeCollections(trusted.document);
    if (
      !collections.some(
        item =>
          item.allowsAnonymous ||
          item.entrypoints.some(entry => entry.allowsAnonymous),
      )
    )
      throw new Error('This catalog does not permit a Public App');
  } else if (observed) {
    if (
      (await proxy.activeKeyedConnection(
        context.platform,
        observed.connectionId,
      )) !== observed.activeId
    )
      throw new Error(
        'The verified connection changed; reconnect this account',
      );
    assertCurrent();
    connectionId = observed.connectionId;
  } else {
    connectionId = config.connectionId;
    if (!connectionId)
      throw new Error('This principal has no saved connection proof');
    const proof = await proxy.keyedPrincipalProvenance(
      context.platform,
      connectionId,
    );
    assertCurrent();
    const principal = config.principal;
    const definitions = describeAuthenticatedPrincipals(
      trusted.document,
    ).filter(
      item =>
        item.namespace === principal.namespace &&
        item.identifier.stable === true &&
        item.identifier.reassigned === false,
    );
    const matches = proof?.principal && same(proof.principal, config.principal);
    const legacy =
      !matches &&
      (await proxy.canReconnectLegacyKeyed(
        context.platform,
        connectionId,
        config.principal,
        definitions,
      ));
    assertCurrent();
    if (definitions.length !== 1 || (!matches && !legacy))
      throw new Error(
        'The saved principal has no matching host identity proof; reconnect it',
      );
  }

  assertCurrent();
  const info = trusted.document.info as { title?: unknown } | undefined;
  const providerName =
    typeof info?.title === 'string' ? info.title : context.platform;
  const destination = await ensureSyncablePrincipalApp(store, {
    drive,
    setup,
    subject,
    proxyOrigin: context.proxyOrigin,
    platform: context.platform,
    principal: config.principal,
    providerName,
    assertCurrent,
    ...(connectionId && connectionId === preferred ? { connectionId } : {}),
  });
  assertCurrent();
  if (
    observed &&
    (await proxy.activeKeyedConnection(
      context.platform,
      observed.connectionId,
    )) !== observed.activeId
  )
    throw new Error('The verified connection changed while opening the App');
  assertCurrent();

  if (preferred && observed?.connectionId === preferred) {
    await proxy.consumePreferredKeyedConnection(
      { drive, app: setup },
      context.platform,
      preferred,
    );
    assertCurrent();
  }

  return destination;
}

export const syncableExecutionKey = (
  drive: string,
  table: string,
  rule?: string,
) => JSON.stringify(rule ? [drive, table, rule] : [drive, table]);
const runOrders = new WeakMap<Store, Map<string, number>>();

// @wc-ignore
async function nextRuleRun(
  store: Store,
  drive: string,
  table: string,
  context: Awaited<ReturnType<typeof syncAppContext>>,
  assertCurrent: () => void,
  floor: number,
): Promise<SyncableRuleRun> {
  const p = context.schema.properties;
  const resource = await store.getResource(table);
  assertCurrent();
  const views = resource.getSubjects(dataBrowser.properties.tableViews);
  if (views.length > 1000)
    throw new Error('The Sync filter count exceeds its allocation budget');
  let visited = 0;

  const safeLocal = (subject: string) => {
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

  for (const subject of views) {
    if (!safeLocal(subject)) continue;
    const view = await store.getResource(subject);
    assertCurrent();
    const raw = view.get(p['syncable-source-config']);
    if (
      view.error ||
      !subjectsReferToSameResource(view.get(core.properties.parent), table) ||
      !view
        .getSubjects(core.properties.isA)
        .includes(dataBrowser.classes.view) ||
      !raw ||
      typeof raw !== 'object' ||
      (raw as { kind?: unknown }).kind !== 'rule'
    )
      continue;
    const rule = parseSyncableRuleConfig(raw);
    if (
      rule.resource !== context.resource ||
      typeof context.sourceKey !== 'string' ||
      view.get(p['syncable-source-key']) !==
        ruleSourceKey(context.sourceKey, rule.ruleKey)
    )
      continue;
    floor = Math.max(
      floor,
      readSyncableRuleStatus(view.get(p['syncable-mirror-status'])).run
        ?.startOrder ?? 0,
    );
    const runClass = context.schema.classes['syncable-sync-run'];
    const runProperty = p['syncable-sync-run'];
    if (!runClass || !runProperty) continue;
    const ledger = new CollectionBuilder(store)
      .setDrive(drive)
      .setPreferServer(true)
      .setProperty(core.properties.parent)
      .setValue(subject)
      .addFilter({ property: core.properties.isA, value: runClass })
      .setPageSize(100)
      .build();
    await ledger.waitForReady();
    assertCurrent();
    if (ledger.totalMembers + visited > 10_000)
      throw new Error('The Sync run ledger exceeds its allocation budget');
    const members = await ledger.getAllMembers();
    assertCurrent();
    if (
      members.length !== ledger.totalMembers ||
      new Set(members).size !== members.length
    )
      throw new Error('The Sync run ledger is incomplete');

    for (const member of members) {
      if (!safeLocal(member))
        throw new Error('The saved Sync run ledger belongs to another server');
      const run = await store.getResource(member);
      assertCurrent();
      const saved = run.get(runProperty) as
        | { startOrder?: unknown; ruleSubject?: unknown; ruleKey?: unknown }
        | undefined;
      if (
        !subjectsReferToSameResource(
          run.get(core.properties.parent),
          subject,
        ) ||
        saved?.ruleSubject !== subject ||
        typeof saved.ruleKey !== 'string' ||
        !saved.ruleKey ||
        typeof saved.startOrder !== 'number' ||
        !Number.isSafeInteger(saved.startOrder) ||
        saved.startOrder < 0
      )
        throw new Error('The saved Sync run ledger is invalid');
      floor = Math.max(floor, saved.startOrder);
      visited++;
    }
  }

  let orders = runOrders.get(store);

  if (!orders) {
    orders = new Map();
    runOrders.set(store, orders);
  }

  const key = JSON.stringify([drive, table]);
  const startOrder = Math.max(
    Date.now(),
    Math.max(floor, orders.get(key) ?? 0) + 1,
  );
  if (!Number.isSafeInteger(startOrder))
    throw new Error('The Sync run order cannot be advanced safely');
  orders.set(key, startOrder);

  return {
    generation: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    startOrder,
  };
}

/** Only installation/schema bootstrap and capability composition live here.
 * The bundled app owns provider discovery and Atomic data reconciliation. */
// @wc-ignore
export async function appProfile(
  store: Store,
  drive: string,
  table: string,
  registry: AppExecutionRegistry,
  signal: AbortSignal,
  worker = false,
  selection?: string,
  ruleSubject?: string,
  queuedAuthority?: () => void,
): Promise<AppExecutionSpec> {
  const actor = store.getAgent();
  if (!actor?.subject) throw new Error('Sign in to use connected services');
  const actorSubject = actor.subject;
  const server = store.getServerUrl();
  const origin = getIntegrationProxy();
  let context = await syncAppContext(
    store,
    drive,
    table,
    !worker,
    selection,
    ruleSubject,
  );
  const resource = await store.getResource(table);
  const statusResource = context.rule
    ? await store.getResource(context.rule.subject)
    : resource;
  const p = context.schema.properties;
  const sourceStamp = () =>
    JSON.stringify([
      resource.get(p['syncable-source-key']),
      resource.get(p['syncable-source-config']),
      resource.get(p['syncable-platform-id']),
      resource.get(p['syncable-proxy-origin']),
    ]);
  const stamp = sourceStamp();

  const assertAuthority = () => {
    queuedAuthority?.();
    assertSyncAppDrive(store, drive, table);
    assertSyncAppContext(context);
    if (
      store.getAgent() !== actor ||
      store.getServerUrl() !== server ||
      getIntegrationProxy() !== origin ||
      sourceStamp() !== stamp
    )
      throw new Error('The integration source, account or server changed');

    if (worker && context.rule?.run) {
      const state = readSyncableRuleStatus(
        statusResource.get(p['syncable-mirror-status']),
      );
      if (
        sourceConfigFingerprint(state.run) !==
        sourceConfigFingerprint(context.rule.run)
      )
        throw new Error('This Sync filter run is no longer current');
      if (state.paused === true || state.enabled === false)
        throw new Error('This Sync filter was paused or disabled');
    }
  };

  const assertCurrent = () => {
    signal.throwIfAborted();
    assertAuthority();
  };

  assertCurrent();

  const status = () => {
    const raw = statusResource.get(p['syncable-mirror-status']);
    if (context.rule) return readSyncableRuleStatus(raw);

    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  };

  const proxy = new ProxyConnections(localStorage, origin, () =>
    store.getAgent(),
  );
  // Only the configured proxy's current catalog can authorize a provider read.
  // Editable saved metadata remains presentation data, never additional authority.
  const metadata = await fetchSyncableDocument(
    context.proxyOrigin,
    signal,
    context.platform,
  );
  const document = prepareDocument(metadata.document);
  const trusted = {
    document,
    querySelection: metadata.querySelection as QuerySelection | undefined,
  };
  const principalDescriptions = describeAuthenticatedPrincipals(document);
  const verifiedPrincipals = new Map<string, VerifiedSyncablePrincipal>();
  const principalApps =
    context.kind === 'platform'
      ? await listSyncablePrincipalApps(store, {
          drive,
          platform: context.platform,
          proxyOrigin: context.proxyOrigin,
          assertCurrent,
        })
      : [];
  assertCurrent();
  context = canonicalSyncAppContext(context, trusted);
  const installationApp = await findSyncablePlatform(store, {
    drive,
    platform: context.platform,
    proxyOrigin: context.proxyOrigin,
  });
  assertCurrent();

  if (!installationApp)
    throw new Error(
      'The integration installation is unavailable. Its saved sources were retained.',
    );
  const flatAdoption = await collectSyncableFlatAdoption(store, {
    drive,
    app: installationApp,
    proxyOrigin: context.proxyOrigin,
    platform: context.platform,
    document,
    querySelection: trusted.querySelection,
    properties: p,
    assertCurrent,
  });
  assertCurrent();
  const appSchema = await findSchema(store, drive, pluginSchema());
  assertCurrent();
  const legacy = await collectSyncableLegacySources(store, {
    drive,
    app: installationApp,
    appDataProperty: appSchema.properties?.['app-data'],
    platform: context.platform,
    proxyOrigin: context.proxyOrigin,
    properties: p,
    collections: describeCollections(document),
    currentSourceIsLegacy: context.kind === 'legacy',
    principalDescriptions,
    principalProvenance: async slot => {
      assertCurrent();
      const proof = await proxy.keyedPrincipalProvenance(
        context.platform,
        slot,
      );
      assertCurrent();

      return proof;
    },
  });
  assertCurrent();

  const legacyReconnectPrincipal = async (slot: string) => {
    const candidates = legacy.sources.filter(
      alias =>
        alias.kind === 'principal' &&
        alias.connectionId === slot &&
        alias.principal?.kind === 'authenticated',
    );
    if (candidates.length !== 1) return;
    const alias = candidates[0];
    if (!alias.sourceKey || !alias.localId || !alias.sourceConfigFingerprint)
      return;
    const row = await store.getResource(alias.subject);

    const assertAliasCurrent = () => {
      assertCurrent();
      assertSyncAppDrive(store, drive, alias.subject);
      if (
        row.get(p['syncable-source-key']) !== alias.sourceKey ||
        row.get(core.properties.localId) !== alias.localId ||
        sourceConfigFingerprint(row.get(p['syncable-source-config'])) !==
          alias.sourceConfigFingerprint
      )
        throw new Error(
          'The saved account source changed; reopen the integration App',
        );
    };

    assertAliasCurrent();
    const principal = alias.principal;
    if (principal?.kind !== 'authenticated') return;
    const eligible = await proxy.canReconnectLegacyKeyed(
      context.platform,
      slot,
      principal,
      principalDescriptions,
    );
    assertAliasCurrent();

    return eligible
      ? { principal, assertCurrent: assertAliasCurrent }
      : undefined;
  };

  if (context.kind === 'legacy') {
    const error = new Error(
      'This saved source needs migration from its integration App. Moved resources are retained and no replacement will be created from this view.',
    );
    Object.assign(error, { installationApp });
    throw error;
  }

  const apiSchema = await syncableApiSchema(
    store,
    drive,
    context.proxyOrigin,
    context.platform,
    metadata.document,
    !worker,
    assertCurrent,
  );
  assertCurrent();

  if (worker && context.resource) {
    if (!context.rule) throw new Error('Select a saved filter to sync');
    if (status().paused === true || status().enabled === false)
      throw new Error('Resume this filter before syncing');
    const [canWriteTable] = await resource.canWrite(actorSubject);
    assertCurrent();
    if (!canWriteTable)
      throw new Error('Write access to this table is required');
    const [canWrite] = await statusResource.canWrite(actorSubject);
    assertCurrent();
    if (!canWrite) throw new Error('Write access to this filter is required');
    const run = await nextRuleRun(
      store,
      drive,
      table,
      context,
      assertCurrent,
      readSyncableRuleStatus(statusResource.get(p['syncable-mirror-status']))
        .run?.startOrder ?? 0,
    );
    assertCurrent();
    await statusResource.set(
      p['syncable-mirror-status'],
      { ...status(), run },
      true,
      undefined,
      assertCurrent,
    );
    assertCurrent();
    await statusResource.save();
    context.rule = { ...context.rule, run };
    assertCurrent();
  }

  const key = syncableExecutionKey(drive, table, context.rule?.subject);

  const assertQueuedAuthority = () => {
    assertAuthority();
    if (status().paused === true || status().enabled === false)
      throw new Error('This Sync filter was paused or disabled');
  };

  const subscribe = (cancel: () => void) => {
    const subjects = new Set([
      table,
      ...(context.rule ? [context.rule.subject] : []),
      ...(context.principalApp ? [context.principalApp] : []),
    ]);
    const removes = [...subjects].map(subject =>
      store.subscribe(subject, () => {
        try {
          assertQueuedAuthority();
        } catch {
          cancel();
        }
      }),
    );

    return () => {
      for (const remove of removes) remove();
    };
  };

  const failed = async (message: string, reportingSignal: AbortSignal) => {
    const assertReporting = () => {
      reportingSignal.throwIfAborted();
      assertQueuedAuthority();
    };

    assertReporting();
    await statusResource.set(
      p['syncable-mirror-status'],
      { ...status(), error: message.slice(0, 1024) },
      true,
      undefined,
      assertReporting,
    );
    assertReporting();
    await statusResource.save();
  };

  const profile: AppFrameProfile = {
    authoritativeQueries: true,
    retainedIdentityProperties: [
      core.properties.localId,
      p['syncable-source-key'],
    ],
    queryMemberInScope: async subject => {
      assertCurrent();
      const included = await classifySyncableResourceDrive(
        store,
        drive,
        subject,
      );
      assertCurrent();
      if (included) assertSyncAppDrive(store, drive, subject);

      return included;
    },
    authorizeRead: async subject => {
      assertCurrent();
      const allowed = await isSyncableResourceInDrive(store, drive, subject);
      assertCurrent();
      if (!allowed)
        throw new Error('The resource is outside the selected drive');
      assertSyncAppDrive(store, drive, subject);
    },
    source: server + '/builtin-syncables-ui?format=html',
    context: {
      ...context,
      ...(context.kind === 'platform' ? { principalApps } : {}),
      document,
      querySelection: trusted.querySelection,
      apiSchema,
      legacySources: legacy.sources,
      legacyWarnings: [...legacy.warnings, ...flatAdoption.warnings],
      legacyMigrationBlocked: legacy.warnings.length > 0,
      flatIdentityAliases: flatAdoption.aliases,
      flatMigrationBlocks: [
        ...flatAdoption.blocks,
        ...unsupportedLegacyFlatBlocks(legacy.sources, context),
      ],
      flatAdoptionRules: flatAdoption.rules,
      worker,
    },
    access: { root: table, signal, assertCurrent },
    proxy: syncProxyTransport(
      proxy,
      context,
      assertCurrent,
      trusted,
      () => {
        if (status().paused === true || status().enabled === false)
          throw new Error('Resume this collection before syncing');
      },
      async slot => !!(await legacyReconnectPrincipal(slot)),
      proof => {
        assertCurrent();
        verifiedPrincipals.set(proof.connectionId, proof);
      },
    ),
    ...(!worker && context.kind === 'platform'
      ? {
          prepareOpenResource: (subject: string) =>
            prepareSyncablePrincipalAppOpen(
              {
                store,
                drive,
                setup: table,
                context,
                trusted,
                proxy,
                verified: verifiedPrincipals,
                principalApps,
                assertCurrent,
              },
              subject,
            ),
        }
      : {}),
    execution: async action => {
      assertCurrent();

      if (worker) {
        if (action !== 'state')
          throw new Error('An execution cannot start another execution');
        registry.ready(key, signal);
      } else if (action === 'cancel') registry.cancel(key);
      else if (action === 'start') {
        if (status().paused === true || status().enabled === false)
          throw new Error('Resume this collection before syncing');
        const [canWrite] = await resource.canWrite(actorSubject);
        assertCurrent();
        if (!canWrite)
          throw new Error('Write access to this table is required');
        if (context.kind !== 'collection')
          throw new Error('Select a collection to sync');
        if (context.resource && !context.rule)
          throw new Error('Select a saved filter to sync');
        await registry.start(
          key,
          async runSignal => {
            assertQueuedAuthority();
            const spec = await appProfile(
              store,
              drive,
              table,
              registry,
              runSignal,
              true,
              selection,
              ruleSubject,
              assertQueuedAuthority,
            );
            assertQueuedAuthority();

            return spec;
          },
          { group: JSON.stringify([drive, table]), subscribe, failed },
        );
      }

      return {
        running: registry.isRunning(key),
        queued: registry.isQueued(key),
      };
    },
    ...(!worker && context.mode !== 'public'
      ? {
          connect: async (platform: string, requestedConnectionId?: string) => {
            assertCurrent();
            if (platform !== context.platform)
              throw new Error('Wrong integration platform');
            if (
              requestedConnectionId !== undefined &&
              (typeof requestedConnectionId !== 'string' ||
                !/^[A-Za-z0-9_-]{43}$/.test(requestedConnectionId))
            )
              throw new Error('Invalid saved connection');
            if (
              context.connectionId &&
              requestedConnectionId !== undefined &&
              requestedConnectionId !== context.connectionId
            )
              throw new Error('Wrong source connection');
            const scope = { drive, app: table, appAgent: actorSubject };
            const connectionId = context.connectionId ?? requestedConnectionId;

            if (connectionId) {
              if (!context.connectionId) {
                if (context.kind !== 'platform')
                  throw new Error('Connect accounts from the integration App');
                const rows = await proxy.listKeyed(platform);
                assertCurrent();
                if (
                  !rows.some(
                    row =>
                      row.connection_id === connectionId &&
                      row.platform === platform,
                  )
                )
                  throw new Error('Unknown saved connection');
              }

              const canReconnect = await proxy.canReconnectKeyed(
                context.platform,
                connectionId,
              );
              assertCurrent();

              if (!canReconnect) {
                const legacyReconnect =
                  await legacyReconnectPrincipal(connectionId);
                if (legacyReconnect) {
                  await proxy.prepareLegacyKeyedReconnect(
                    context.platform,
                    connectionId,
                    legacyReconnect.principal,
                    principalDescriptions,
                    legacyReconnect.assertCurrent,
                  );
                  assertCurrent();
                } else
                  throw new Error(
                    'Open the integration App to reconnect this account',
                  );
              }

              assertCurrent();

              const handoff = await proxy.startKeyedReconnect(
                scope,
                context.platform,
                connectionId,
                location.href,
                'Atomic Syncables',
              );
              assertCurrent();

              return handoff;
            }

            if (context.kind !== 'platform')
              throw new Error('Connect accounts from the integration App');

            const handoff = await proxy.startKeyed(
              scope,
              platform,
              location.href,
              'Atomic Syncables',
            );
            assertCurrent();

            return handoff;
          },
        }
      : {}),
  };

  return {
    app: table,
    drive,
    table,
    profile,
    subscribe,
    failed,
  };
}

export function BuiltinSyncablesApp({
  table,
  drive,
  ruleSubject: selectedRule,
}: {
  table: string;
  drive: string;
  ruleSubject?: string;
}) {
  const store = useStore();
  const [actor] = useCurrentAgent();
  const [server] = useServerURL();
  const origin = useIntegrationProxy();
  const selection = ShowRoute.useSearch({ select: search => search.syncRow });
  const routeRule = ShowRoute.useSearch({
    select: search => search.syncFilter,
  });
  const ruleSubject = selectedRule ?? routeRule;
  const registry = useAppExecutions();
  const [loaded, setLoaded] = useState<{
    table: string;
    drive: string;
    selection?: string;
    ruleSubject?: string;
    profile: AppFrameProfile;
  }>();
  const [error, setError] = useState<{
    message: string;
    installationApp?: string;
  }>();
  useEffect(() => {
    if (!registry) return;
    const controller = new AbortController();
    void appProfile(
      store,
      drive,
      table,
      registry,
      controller.signal,
      false,
      selection,
      ruleSubject,
    )
      .then(spec => {
        if (!controller.signal.aborted) {
          setError(undefined);
          setLoaded({
            table,
            drive,
            selection,
            ruleSubject,
            profile: spec.profile,
          });
        }
      })
      .catch(reason => {
        if (!controller.signal.aborted)
          setError({
            message: String(reason.message ?? reason),
            ...(typeof reason.installationApp === 'string'
              ? { installationApp: reason.installationApp }
              : {}),
          });
      });

    return () => controller.abort();
  }, [
    store,
    drive,
    table,
    selection,
    ruleSubject,
    registry,
    actor,
    server,
    origin,
  ]);
  if (error)
    return (
      <div role='alert'>
        <p>{error.message}</p>
        {error.installationApp && (
          <AtomicLink subject={error.installationApp}>
            Open integration App
          </AtomicLink>
        )}
      </div>
    );
  if (
    !loaded ||
    loaded.table !== table ||
    loaded.drive !== drive ||
    loaded.ruleSubject !== ruleSubject ||
    loaded.selection !== selection
  )
    return <p role='status'>Opening Sync…</p>;

  return (
    <AppFrame
      key={JSON.stringify([drive, table, selection, ruleSubject])}
      app={table}
      drive={drive}
      table={table}
      profile={loaded.profile}
    />
  );
}
