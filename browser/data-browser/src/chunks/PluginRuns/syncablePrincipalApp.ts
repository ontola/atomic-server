// @wc-ignore-file
import {
  canonicalIdentifier,
  core,
  dataBrowser,
  ensureSchema,
  findSchema,
  isNotFound,
  pluginSchema,
  readConnectionSubjects,
  server,
  subjectsReferToSameResource,
  type JSONValue,
  type Resource,
  type Store,
  type SchemaStore,
} from '@tomic/lib';
import {
  principalIdentity,
  sourceConfigFingerprint,
  sourceKey,
  type SyncablePrincipal,
} from './builtinSyncIdentity.js';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
} from './syncableSource';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  isSyncableResourceInDrive,
  classifySyncableResourceDrive,
  assertSyncableResourceActive,
  assertSyncableLocalSubject,
  platformLocalId,
  queueSyncableProvisioning,
  syncablePlatformSchema,
} from './syncablePlatform';

type SchemaResource = Awaited<ReturnType<SchemaStore['getResource']>>;

export interface SyncablePrincipalAppRef {
  subject: string;
  principal: SyncablePrincipal;
  connectionId?: string;
  name: string;
}
interface PrincipalScope {
  drive: string;
  proxyOrigin: string;
  platform: string;
  principal?: SyncablePrincipal;
  assertCurrent?: () => void;
}

export interface EnsureSyncablePrincipalAppInput extends PrincipalScope {
  setup: string;
  subject: string;
  principal: SyncablePrincipal;
  providerName: string;
  assertCurrent: () => void;
  /** May only be supplied after the host verified this slot's typed identity. */
  connectionId?: string;
}
const DRIVE = 'https://atomicdata.dev/properties/drive';
const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
const same = (a: unknown, b: unknown) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  subjectsReferToSameResource(a, b);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

async function terms(store: SchemaStore, drive: string, create = false) {
  assertSyncableLocalSubject(store, drive);
  const root = await store.getResource(drive);
  const ontology = root.get(server.properties.defaultOntology);
  if (typeof ontology === 'string') assertSyncableLocalSubject(store, ontology);
  const resolve = create ? ensureSchema : findSchema;
  const [platform, hierarchy, app] = await Promise.all([
    resolve(store, drive, syncablePlatformSchema()),
    resolve(store, drive, syncableHierarchySchema()),
    resolve(store, drive, pluginSchema()),
  ]);

  return {
    p: platform.properties ?? {},
    h: hierarchy.properties ?? {},
    c: { ...platform.classes, ...hierarchy.classes },
    app,
  };
}

type Terms = Awaited<ReturnType<typeof terms>>;

/** A validated, stored principal; display names and connection slots are not identity. */
function principalOf(
  row: SchemaResource,
  scope: Pick<PrincipalScope, 'platform' | 'proxyOrigin'>,
  t: Terms,
) {
  const keyProperty = t.h['syncable-source-key'];
  const configProperty = t.h['syncable-source-config'];
  const kindProperty = t.h['syncable-node-kind'];
  if (!keyProperty || !configProperty || !kindProperty) return undefined;
  const raw = row.get(keyProperty);
  const config = parseSyncableSourceConfig(row.get(configProperty));
  const key = parseSyncableSourceKey(raw);
  if (
    ('error' in row && row.error) ||
    key.version !== 2 ||
    key.kind !== 'principal' ||
    config.version !== 2 ||
    key.proxyOrigin !== scope.proxyOrigin ||
    key.platform !== scope.platform ||
    typeof raw !== 'string' ||
    !sourceConfigMatchesKey(config, key, raw) ||
    row.get(kindProperty) !== 'principal' ||
    !list(row.get(core.properties.isA)).includes(dataBrowser.classes.table) ||
    !t.c['syncable-principal'] ||
    !list(row.get(core.properties.isA)).includes(t.c['syncable-principal'])
  )
    throw new Error(
      'The principal source identity does not match its saved data',
    );

  return { key: raw, config, principal: principalIdentity(config.principal) };
}

/** Check registration after the caller has proved the principal source. */
async function isRegisteredPrincipalApp(
  store: SchemaStore,
  drive: string,
  row: SchemaResource,
  t: Terms,
  scope: Pick<PrincipalScope, 'platform' | 'proxyOrigin'>,
): Promise<boolean> {
  const app = t.app.classes?.app;
  const data = t.app.properties?.['app-data'];

  return (
    !!app &&
    !!data &&
    !!t.p['builtin-app'] &&
    !!t.p['syncable-platform-id'] &&
    !!t.p['syncable-proxy-origin'] &&
    list(row.get(core.properties.isA)).includes(app) &&
    row.get(t.p['builtin-app']) === 'syncables' &&
    row.get(t.p['syncable-platform-id']) === scope.platform &&
    row.get(t.p['syncable-proxy-origin']) === scope.proxyOrigin &&
    same(row.get(data), row.subject) &&
    (await isSyncableResourceInDrive(store, drive, row.subject))
  );
}

/** Read-only App resolver validation; never creates metadata or fetches a provider. */
export async function isSyncablePrincipalApp(
  store: SchemaStore,
  drive: string,
  row: SchemaResource,
): Promise<boolean> {
  const t = await terms(store, drive);
  const source =
    t.h['syncable-source-key'] && row.get(t.h['syncable-source-key']);
  if (source === undefined) return false;
  const key = parseSyncableSourceKey(source);
  if (key.version !== 2 || key.kind !== 'principal') return false;

  return (
    !!principalOf(row, key, t) &&
    (await isRegisteredPrincipalApp(store, drive, row, t, key))
  );
}

/** Cached lookup for execution binding only; never used to infer install absence. */
export async function findRegisteredSyncablePrincipalApp(
  store: SchemaStore,
  input: PrincipalScope & { principal: SyncablePrincipal },
): Promise<SyncablePrincipalAppRef | undefined> {
  const assert = input.assertCurrent ?? (() => {});
  assert();
  const t = await terms(store, input.drive);
  assert();
  const indexProperty = t.p['syncable-principal-app-index'];
  if (!indexProperty) return undefined;
  const root = await store.getResource(input.drive);
  assert();
  const index = root.get(indexProperty);
  if (!index || typeof index !== 'object' || Array.isArray(index))
    return undefined;
  const key = sourceKey({ ...input, kind: 'principal' });
  const subject = (index as Record<string, unknown>)[
    sourceConfigFingerprint(key)
  ];
  if (subject === undefined) return undefined;
  if (typeof subject !== 'string')
    throw new Error('The principal App index is invalid');
  assertSyncableLocalSubject(store, subject);
  const row = await store.getResource(subject);
  assert();
  const parsed = principalOf(row, input, t);
  if (
    !parsed ||
    parsed.key !== key ||
    !(await isRegisteredPrincipalApp(store, input.drive, row, t, input))
  )
    throw new Error(
      'The registered principal App no longer matches this source',
    );
  assert();

  return {
    subject: row.subject,
    principal: parsed.principal,
    ...(parsed.config.connectionId
      ? { connectionId: parsed.config.connectionId }
      : {}),
    name: String(row.get(core.properties.name) ?? input.platform),
  };
}

/** The server index can include unstamped legacy rows from another Drive. */
async function principalSubjectsInDrive(
  store: Store,
  drive: string,
  property: string,
  value: string,
  assertCurrent: () => void,
  includeTrashed = true,
) {
  assertCurrent();
  const subjects = await readConnectionSubjects(store, drive, property, value, {
    includeTrashed,
  });
  assertCurrent();
  const scoped: string[] = [];

  for (const subject of subjects) {
    const included = await classifySyncableResourceDrive(store, drive, subject);
    assertCurrent();

    if (included) {
      if (includeTrashed)
        await assertSyncableResourceActive(store, drive, subject);
      assertCurrent();
      scoped.push(subject);
    }
  }

  return scoped;
}

/** Complete server-authoritative lookup; a browser cache or root index cannot prove absence. */
export async function listSyncablePrincipalApps(
  store: Store,
  scope: PrincipalScope,
): Promise<readonly SyncablePrincipalAppRef[]> {
  platformLocalId(scope.proxyOrigin, scope.platform);
  const assert = scope.assertCurrent ?? (() => {});
  const actor = store.getAgent()?.subject;
  const serverURL = store.getServerUrl();

  const check = () => {
    assert();
    if (
      store.getAgent()?.subject !== actor ||
      store.getServerUrl() !== serverURL
    )
      throw new Error('The active account or server changed');
  };

  check();
  const t = await terms(store, scope.drive);
  check();
  const kind = t.h['syncable-node-kind'];
  if (!kind) return [];
  const expectedKey = scope.principal
    ? sourceKey({ ...scope, principal: scope.principal, kind: 'principal' })
    : undefined;
  const subjects = await principalSubjectsInDrive(
    store,
    scope.drive,
    expectedKey ? t.h['syncable-source-key'] : kind,
    expectedKey ?? 'principal',
    check,
    expectedKey !== undefined,
  );
  check();
  const apps: SyncablePrincipalAppRef[] = [];
  const seen = new Set<string>();

  for (const subject of subjects) {
    assertSyncableLocalSubject(store, subject);
    const row = await store.getResource(subject);
    check();
    const rawConfig = row.get(t.h['syncable-source-config']) as
      | Record<string, unknown>
      | undefined;
    const matchesScope =
      (rawConfig?.proxyOrigin === scope.proxyOrigin &&
        rawConfig?.platform === scope.platform) ||
      (t.p['syncable-platform-id'] &&
        t.p['syncable-proxy-origin'] &&
        row.get(t.p['syncable-platform-id']) === scope.platform &&
        row.get(t.p['syncable-proxy-origin']) === scope.proxyOrigin);
    if (!matchesScope) continue;
    const parsed = principalOf(row, scope, t);
    if (
      !parsed ||
      !t.app.classes?.app ||
      !list(row.get(core.properties.isA)).includes(t.app.classes.app)
    )
      continue;
    if (!(await isRegisteredPrincipalApp(store, scope.drive, row, t, scope)))
      throw new Error(
        'The saved principal App is invalid or outside this drive',
      );
    check();
    if (seen.has(parsed.key))
      throw new Error(
        'This principal has conflicting Apps; review the existing copies',
      );
    seen.add(parsed.key);
    apps.push({
      subject: row.subject,
      principal: parsed.principal,
      ...(parsed.config.connectionId
        ? { connectionId: parsed.config.connectionId }
        : {}),
      name: String(row.get(core.properties.name) ?? scope.platform),
    });
  }

  return apps;
}

/**
 * Native-only promotion. The caller supplies identity proved by a catalog response
 * (or its trusted host marker); frame-supplied labels/configuration are not proof.
 * No iframe is granted access to the drive or the native registration resource.
 */
export function ensureSyncablePrincipalApp(
  store: Store,
  input: EnsureSyncablePrincipalAppInput,
): Promise<string> {
  return queueSyncableProvisioning(store, input.drive, () =>
    promote(store, input),
  );
}

async function promote(
  store: Store,
  input: EnsureSyncablePrincipalAppInput,
): Promise<string> {
  const { drive, proxyOrigin, platform } = input;
  for (const subject of [drive, input.setup, input.subject])
    assertSyncableLocalSubject(store, subject);
  platformLocalId(proxyOrigin, platform);
  const principal = principalIdentity(input.principal);
  const expectedKey = sourceKey({
    proxyOrigin,
    platform,
    principal,
    kind: 'principal',
  });
  if (
    input.connectionId !== undefined &&
    (principal.kind === 'public' ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.connectionId))
  )
    throw new Error('Invalid verified principal connection');
  const actor = store.getAgent()?.subject;
  const serverURL = store.getServerUrl();
  if (!actor) throw new Error('Sign in before installing a principal App');

  const checkSession = () => {
    input.assertCurrent();
    if (
      store.getAgent()?.subject !== actor ||
      store.getServerUrl() !== serverURL
    )
      throw new Error('The active account or server changed');
  };

  checkSession();

  for (const subject of [input.setup, input.subject]) {
    await assertSyncableResourceActive(store, drive, subject);
    checkSession();
  }

  const t = await terms(store, drive, true);
  checkSession();
  const fields = [
    ...new Set([
      core.properties.parent,
      core.properties.isA,
      core.properties.localId,
      core.properties.name,
      core.properties.read,
      core.properties.write,
      core.properties.classtype,
      DRIVE,
      server.properties.defaultOntology,
      dataBrowser.properties.icon,
      dataBrowser.properties.trashFolder,
      dataBrowser.properties.tableViews,
      dataBrowser.properties.tableDefaultView,
      ...Object.values(t.p),
      t.h['syncable-source-key'],
      t.h['syncable-source-config'],
      t.h['syncable-node-kind'],
      t.app.properties!['app-data'],
    ]),
  ];
  const stamp = (row: Resource) =>
    sourceConfigFingerprint(
      Object.fromEntries(fields.map(p => [p, row.get(p)])),
    );
  const pinned = new Map<Resource, string>();

  const check = () => {
    checkSession();
    for (const [row, saved] of pinned)
      if (stamp(row) !== saved)
        throw new Error(
          'The principal App source or destination changed; reopen it',
        );
  };

  const load = async (subject: string) => {
    assertSyncableLocalSubject(store, subject);
    const row = await store.getResource(subject);
    assertSyncableLocalSubject(store, row.subject);
    check();
    if (row.error) throw row.error;
    pinned.set(row, stamp(row));

    return row;
  };

  const within = async (subject: string) => {
    let current = subject;
    const seen = new Set<string>();

    for (let depth = 0; depth < 64 && !seen.has(current); depth++) {
      if (same(current, drive)) return;
      seen.add(current);
      const row = await load(current);
      const assigned = row.get(DRIVE);
      if (assigned !== undefined && !same(assigned, drive)) break;
      const parent = text(row.get(core.properties.parent));
      if (!parent) break;
      current = parent;
    }

    throw new Error('The principal App is outside the selected drive');
  };

  const root = await load(drive);
  const setup = await load(input.setup);
  const row = await load(input.subject);
  await within(setup.subject);
  await within(row.subject);

  for (const subject of [setup.subject, row.subject]) {
    await assertSyncableResourceActive(store, drive, subject);
    check();
  }

  check();
  const candidate = principalOf(row, input, t);
  if (
    !candidate ||
    candidate.key !== expectedKey ||
    setup.get(t.p['builtin-app']) !== 'syncables' ||
    setup.get(t.p['syncable-platform-id']) !== platform ||
    setup.get(t.p['syncable-proxy-origin']) !== proxyOrigin ||
    setup.get(core.properties.localId) !==
      platformLocalId(proxyOrigin, platform) ||
    setup.get(t.h['syncable-node-kind']) === 'principal' ||
    !t.app.classes?.app ||
    !list(setup.get(core.properties.isA)).includes(t.app.classes.app) ||
    !same(setup.get(t.app.properties!['app-data']), setup.subject)
  )
    throw new Error(
      'The principal App does not belong to this verified installation',
    );
  const already = list(row.get(core.properties.isA)).includes(
    t.app.classes.app,
  );
  if (!already && !same(row.get(core.properties.parent), setup.subject))
    throw new Error(
      'The uninstalled principal moved; reopen its original connection manager',
    );

  const assertUniquePrincipal = async () => {
    const matches = await principalSubjectsInDrive(
      store,
      drive,
      t.h['syncable-source-key'],
      expectedKey,
      check,
    );
    check();
    if (matches.length !== 1 || !same(matches[0], row.subject))
      throw new Error(
        'This principal source is missing or conflicting; review all existing copies',
      );
  };

  await assertUniquePrincipal();
  const ontologySubject = text(root.get(server.properties.defaultOntology));
  if (!ontologySubject)
    throw new Error('The drive has no native registration destination');
  const ontology = await load(ontologySubject);
  await within(ontology.subject);

  const assertWritable = async (target: Resource) => {
    const [allowed] = await target.canWrite(actor);
    check();
    if (!allowed)
      throw new Error('Write access is required to install this principal App');
  };

  for (const target of [root, row, ontology]) await assertWritable(target);
  const claimId =
    'syncables:principal-app:' + sourceConfigFingerprint(expectedKey);
  const claimTarget = t.p['syncable-principal-app-target'];
  const validClaim = (get: (property: string) => unknown) =>
    list(get(core.properties.isA)).includes(
      t.c['syncable-principal-app-registration'],
    ) &&
    get(core.properties.localId) === claimId &&
    get(t.p['syncable-principal-app-key']) === expectedKey &&
    same(get(core.properties.parent), ontology.subject);
  const conflictingClaim = () =>
    new Error(
      'This principal already has another registered App; its saved data was retained',
    );

  const findClaim = async () => {
    const subjects = await principalSubjectsInDrive(
      store,
      drive,
      core.properties.localId,
      claimId,
      check,
    );
    check();
    const found: Resource[] = [];

    for (const subject of subjects) {
      const claim = await load(subject);
      if (same(claim.get(core.properties.parent), ontology.subject))
        found.push(claim);
    }

    if (found.length > 1)
      throw new Error('The principal App registration is conflicting');

    return found[0];
  };

  const write = async (property: string, value: JSONValue, target = row) => {
    check();
    if (
      sourceConfigFingerprint(target.get(property)) ===
      sourceConfigFingerprint(value)
    )
      return;
    const previous = fields.map(p => target.get(p));
    const expected = sourceConfigFingerprint(
      Object.fromEntries(
        fields.map((p, i) => [p, p === property ? value : previous[i]]),
      ),
    );
    await target.set(property, value, true, undefined, check);
    checkSession();
    if (stamp(target) !== expected)
      throw new Error('The principal changed during installation');
    pinned.set(target, expected);
    check();
    await target.save();
    check();
  };

  let claim = await findClaim();

  if (claim && !same(claim.get(claimTarget), row.subject)) {
    const previous = text(claim.get(claimTarget));
    if (!previous || !validClaim(claim.get.bind(claim)))
      throw conflictingClaim();
    assertSyncableLocalSubject(store, previous);
    if (store.hasPendingDestroy(previous)) throw conflictingClaim();
    const saved = await store.readServerSnapshot(claim.subject);
    check();
    if (
      !validClaim(property => saved[property]) ||
      !same(saved[claimTarget], previous)
    )
      throw conflictingClaim();
    const missing = await store
      .readServerSnapshot(previous)
      .then(() => false, isNotFound);
    check();
    if (!missing || store.hasPendingDestroy(previous)) throw conflictingClaim();
    await assertUniquePrincipal();
    await assertWritable(claim);
    // Release only this stale registration's local ID. The existing
    // server uniqueness check then arbitrates concurrent replacements.
    await write(
      core.properties.localId,
      'syncables:retired-principal-app:' +
        sourceConfigFingerprint(canonicalIdentifier(claim.subject)),
      claim,
    );
    claim = await findClaim();
  }

  const resumedClaim = !!claim;

  if (!claim) {
    check();
    const created = await store.newResource({
      parent: ontology.subject,
      isA: [t.c['syncable-principal-app-registration']],
      propVals: {
        [core.properties.localId]: claimId,
        [core.properties.name]:
          `${input.providerName} · ${String(row.get(core.properties.name) ?? (principal.kind === 'public' ? 'Public' : principal.subject))}`.slice(
            0,
            200,
          ),
        [t.p['syncable-principal-app-key']]: expectedKey,
        [claimTarget]: row.subject,
      },
    });
    check();

    try {
      await created.save();
      check();
      claim = created;
    } catch (reason) {
      check();
      claim = await findClaim();
      if (!claim) throw reason;
    }
  }

  if (
    !validClaim(claim.get.bind(claim)) ||
    !same(claim.get(claimTarget), row.subject)
  )
    throw conflictingClaim();
  pinned.set(claim, stamp(claim));

  if (
    input.connectionId &&
    candidate.config.connectionId !== input.connectionId
  )
    await write(t.h['syncable-source-config'], {
      ...(row.get(t.h['syncable-source-config']) as Record<string, JSONValue>),
      connectionId: input.connectionId,
    });
  await write(t.p['builtin-app'], 'syncables');
  await write(t.p['syncable-platform-id'], platform);
  await write(t.p['syncable-proxy-origin'], proxyOrigin);
  await write(t.app.properties!['app-data'], row.subject);

  for (const property of [
    t.p['syncable-api-document'],
    t.p['syncable-api-selection'],
  ]) {
    const value = setup.get(property);
    if (row.get(property) === undefined && value !== undefined)
      await write(property, value as JSONValue);
  }

  if (
    !already &&
    !row.get(dataBrowser.properties.icon) &&
    typeof setup.get(dataBrowser.properties.icon) === 'string'
  )
    await write(
      dataBrowser.properties.icon,
      setup.get(dataBrowser.properties.icon) as string,
    );

  if (!already) {
    const claimedName = text(claim.get(core.properties.name));
    if (!claimedName)
      throw new Error('The principal App registration has no saved name');
    await write(core.properties.name, claimedName);
    await write(core.properties.isA, [
      ...new Set([...list(row.get(core.properties.isA)), t.app.classes.app]),
    ]);
  }

  if (
    !already ||
    (resumedClaim && claim.get(t.p['syncable-principal-app-ready']) !== true)
  ) {
    if (
      !same(row.get(core.properties.parent), input.setup) &&
      !same(row.get(core.properties.parent), drive)
    )
      throw new Error(
        'The unfinished principal App moved; its data was retained',
      );
    await write(core.properties.parent, drive);
  }

  await write(t.p['syncable-principal-app-ready'], true, claim);
  const indexProperty = t.p['syncable-principal-app-index'];
  const currentIndex = root.get(indexProperty);
  const index =
    currentIndex &&
    typeof currentIndex === 'object' &&
    !Array.isArray(currentIndex)
      ? (currentIndex as Record<string, JSONValue>)
      : {};
  await write(
    indexProperty,
    { ...index, [sourceConfigFingerprint(expectedKey)]: row.subject },
    root,
  );
  check();

  return row.subject;
}
