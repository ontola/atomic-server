// @wc-ignore-file
/** Read-only compatibility for the historical built-in storage format.
 * These aliases describe saved identities, never provider operations or responses. */
import {
  core,
  collections as collectionTerms,
  isCommitSubject,
  type Collections,
  isAtomicIdentifier,
  subjectsReferToSameResource,
  type Store,
} from '@tomic/lib';
import type {
  AuthenticatedPrincipalDescription,
  CollectionDescription,
} from 'syncables/browser';
import type { KeyedPrincipalProvenance } from '@helpers/proxyConnections';
import {
  sourceConfigFingerprint,
  principalIdentity,
  type SyncablePrincipal,
  type LegacySourceAlias,
} from './builtinSyncIdentity.js';
import { parseSyncableRuleConfig } from './syncableRules';
import {
  parseSyncableSourceConfig,
  sourceConfigMatchesKey,
} from './syncableSource';
import {
  parseSyncableSourceKey,
  type LegacySyncableSourceKey,
} from './syncableSource';

const DRIVE = 'https://atomicdata.dev/properties/drive';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sameSubject = (left: unknown, right: unknown) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  subjectsReferToSameResource(left, right);

const integer = (value: unknown): number | undefined => {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !/^[1-9][0-9]*$/.test(String(value))
  )
    return;
  const number = Number(value);

  return Number.isSafeInteger(number) ? number : undefined;
};

export interface SyncableLegacyOptions {
  drive: string;
  app: string;
  proxyOrigin: string;
  platform: string;
  properties: Record<string, string>;
  collections: CollectionDescription[];
  /** Hard bound applies to candidates and all ancestry reads together. */
  maxResources?: number;
  /** Native-resolved App data property; absent for unsupported legacy hosts. */
  appDataProperty?: string;
  /** Enables discovery when opening an otherwise unlinked historical source. */
  currentSourceIsLegacy?: boolean;
  /** The configured proxy's current declared identity metadata. */
  principalDescriptions?: AuthenticatedPrincipalDescription[];
  /** Host-held browser provenance, never an Atomic label or iframe assertion. */
  principalProvenance?: (
    slot: string,
  ) => Promise<KeyedPrincipalProvenance | undefined>;
}
export interface SyncableLegacyResult {
  sources: LegacySourceAlias[];
  warnings: string[];
}
type Row = Awaited<ReturnType<Store['getResource']>>;
interface HistoricalRow {
  row: Row;
  key: LegacySyncableSourceKey;
  raw: string;
  config: Record<string, unknown>;
  slot?: string;
  public: boolean;
}

/** Collect only the selected installation, its known aliases and its saved tree.
 * A drive stamp is never a substitute for walking the complete parent chain. */
export async function collectSyncableLegacySources(
  store: Store,
  options: SyncableLegacyOptions,
): Promise<SyncableLegacyResult> {
  const {
    drive,
    app,
    proxyOrigin,
    platform,
    properties: p,
    collections,
  } = options;
  const sources: LegacySourceAlias[] = [];
  const warnings = new Set<string>();
  const cache = new Map<string, Row>();
  const attempted = new Set<string>();
  const unavailable = new Set<string>();
  const maximum = Math.min(options.maxResources ?? 10_000, 20_000);
  if (!Number.isInteger(maximum) || maximum < 1)
    throw new Error('Invalid legacy source resource limit');
  const warn = (message: string) => warnings.add(message);

  const local = (subject: unknown): subject is string => {
    if (typeof subject !== 'string' || !subject || subject.length > 4096)
      return false;
    // Check before getResource: a forged index must never trigger federation.
    if (isAtomicIdentifier(subject) || !subject.includes(':')) return true;

    try {
      const url = new URL(subject);

      return (
        ['https:', 'http:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !store.isForeignOriginSubject(subject)
      );
    } catch {
      return false;
    }
  };

  const load = async (subject: string): Promise<Row | undefined> => {
    if (!local(subject) || unavailable.has(subject)) return;
    const found = cache.get(subject);
    if (found) return found;
    attempted.add(subject);
    if (attempted.size > maximum)
      throw new Error('Legacy source migration exceeds its resource limit');

    try {
      const row = await store.getResource(subject);

      if (row.error) {
        unavailable.add(subject);

        return;
      }

      cache.set(subject, row);

      return row;
    } catch {
      unavailable.add(subject);
      warn('Some saved legacy resources are unavailable; they were retained.');

      return;
    }
  };

  const inDrive = async (subject: string) => {
    const seen = new Set<string>();
    let current = subject;

    for (let depth = 0; depth < 64 && !seen.has(current); depth++) {
      if (sameSubject(current, drive)) return true;
      seen.add(current);
      const row = await load(current);
      if (!row) return false;
      const stamp = row.get(DRIVE);
      if (stamp !== undefined && !sameSubject(stamp, drive)) return false;
      const parent = row.get(core.properties.parent);
      if (!local(parent)) return false;
      current = parent;
    }

    return false;
  };

  const installation = await load(app);
  if (
    !installation ||
    !(await inDrive(app)) ||
    installation.get(p['syncable-platform-id']) !== platform ||
    installation.get(p['syncable-proxy-origin']) !== proxyOrigin
  )
    throw new Error(
      'The legacy installation does not match the selected source',
    );
  if (platform !== 'github-issues') return { sources, warnings: [] };

  const pending = [app];
  const driveRow = await load(drive);

  for (const row of [installation, driveRow]) {
    if (!row) continue;
    const index = row.get(p['syncable-resource-index']);
    if (!record(index)) continue;
    if (Object.keys(index).length > maximum)
      throw new Error('Legacy source migration exceeds its resource limit');

    for (const [key, subject] of Object.entries(index)) {
      try {
        const parsed = parseSyncableSourceKey(key);
        if (
          parsed.version === 1 &&
          parsed.proxyOrigin === proxyOrigin &&
          parsed.platform === platform &&
          local(subject)
        )
          pending.push(subject);
      } catch {
        /* Unknown index formats are not migration authority. */
      }
    }
  }

  const accounts = installation.get(p['syncable-legacy-accounts']);
  if (local(accounts)) pending.push(accounts);
  // New installations point appData at the App itself. Older Apps acquire
  // that binding only after their validated Accounts pointer is saved.
  // With no historical index/current source either, avoid walking every
  // modern imported row merely to prove there is nothing to migrate.
  if (
    options.appDataProperty !== undefined &&
    sameSubject(installation.get(options.appDataProperty), app) &&
    !local(accounts) &&
    pending.length === 1 &&
    options.currentSourceIsLegacy !== true
  )
    return { sources, warnings: [...warnings] };
  const visited = new Set<string>();
  const historical = new Map<string, HistoricalRow>();
  const modern = new Map<string, LegacySourceAlias>();
  const flatIssues = new Map<string, Row>();
  const sourceProperty = p['syncable-source-key'];
  const nodeProperty = p['syncable-node-kind'];

  let driveQueried = false;
  let legacyEvidence =
    options.currentSourceIsLegacy === true || local(accounts);

  while (
    pending.length ||
    (!driveQueried && (legacyEvidence || historical.size || flatIssues.size))
  ) {
    if (!pending.length) {
      driveQueried = true;

      // The normal signed, drive-scoped query finds moved legacy sources even
      // when an earlier implementation never populated its optional index.
      // CollectionBuilder deliberately treats an absent value as a disabled
      // query. Property-presence discovery must use the Store's existing
      // signed server query path rather than silently accepting that empty set.
      const pageOfSources = async (page: number) => {
        const url = new URL('/query', store.getServerUrl());
        for (const [name, value] of Object.entries({
          drive,
          property: sourceProperty,
          page_size: '100',
          current_page: String(page),
          include_nested: 'false',
        }))
          url.searchParams.set(name, value);
        const response =
          await store.fetchResourceFromServer<Collections.Collection>(
            url.href,
            // A synthetic query response is authoritative for this page, not
            // another concurrent edit of the preceding result snapshot.
            { noWebSocket: true, forceOverride: true },
          );
        if (response.error) throw response.error;
        // App setup has already initialized Loro. Materialize a buffered query
        // response before reading its count and subject-only members.
        response.getLoroDoc();
        const total = response.get(collectionTerms.properties.totalMembers);
        if (
          typeof total !== 'number' ||
          !Number.isSafeInteger(total) ||
          total < 0
        )
          throw new Error('Legacy source discovery returned an invalid count');
        if (total > maximum)
          throw new Error('Legacy source migration exceeds its resource limit');

        return {
          total,
          members: response.getSubjects(collectionTerms.properties.members),
        };
      };

      const first = await pageOfSources(0);
      const observed = new Set<string>();
      const rawObserved = new Set<string>();

      // The query endpoint uses offset=page_size*current_page, so every
      // nonfinal page must be full. Check the zero-count first page as well.
      for (
        let page = 0;
        page < Math.max(1, Math.ceil(first.total / 100));
        page++
      ) {
        const result = page === 0 ? first : await pageOfSources(page);
        if (result.total !== first.total)
          throw new Error(
            'Legacy source discovery changed; retry after drive synchronization',
          );

        const expected = Math.min(100, first.total - page * 100);
        if (result.members.length !== expected)
          throw new Error(
            'Legacy source discovery is incomplete; retry after drive synchronization',
          );

        // Validate raw membership before discarding commits or foreign subjects:
        // otherwise filtered duplicates can conceal a missing moved resource.
        for (const subject of result.members) {
          const normalized = store.normalizeSubject(subject);
          if (rawObserved.has(normalized))
            throw new Error(
              'Legacy source discovery repeated a resource; retry after drive synchronization',
            );
          rawObserved.add(normalized);
          if (isCommitSubject(subject) || !local(subject)) continue;
          observed.add(store.normalizeSubject(subject));
          if (!visited.has(subject)) pending.push(subject);
        }

        if (pending.length + visited.size > maximum)
          throw new Error('Legacy source migration exceeds its resource limit');
      }

      if (rawObserved.size !== first.total)
        throw new Error(
          'Legacy source discovery is incomplete; retry after drive synchronization',
        );

      for (const old of historical.values())
        if (!observed.has(store.normalizeSubject(old.row.subject)))
          throw new Error(
            'Legacy source discovery is incomplete; retry after drive synchronization',
          );

      continue;
    }

    const subject = pending.shift()!;
    if (visited.has(subject)) continue;
    visited.add(subject);
    if (visited.size > maximum)
      throw new Error('Legacy source migration exceeds its resource limit');
    const row = await load(subject);
    if (!row || !(await inDrive(subject))) continue;
    const raw = row.get(sourceProperty);
    let descend =
      subject === app ||
      sameSubject(subject, accounts) ||
      (row.get(core.properties.localId) === 'syncables:accounts' &&
        sameSubject(row.get(core.properties.parent), app) &&
        row.get(p['syncable-platform-id']) === platform &&
        row.get(p['syncable-proxy-origin']) === proxyOrigin);
    if (descend && subject !== app) legacyEvidence = true;

    if (typeof raw === 'string') {
      try {
        const savedConfig = row.get(p['syncable-source-config']);

        if (
          record(savedConfig) &&
          savedConfig.version === 3 &&
          savedConfig.kind === 'rule'
        ) {
          parseSyncableRuleConfig(savedConfig);
          continue;
        }

        const key = parseSyncableSourceKey(raw);
        if (key.proxyOrigin !== proxyOrigin || key.platform !== platform)
          continue;

        if (key.version === 3) continue;

        if (key.version === 2) {
          const value = parseSyncableSourceConfig(
            row.get(p['syncable-source-config']),
          );

          if (
            !sourceConfigMatchesKey(value, key, raw) ||
            row.get(nodeProperty) !== key.kind
          ) {
            warn(
              'A current source configuration does not match its saved identity.',
            );
            continue;
          }

          modern.set(subject, {
            subject,
            kind: key.kind,
            principal: key.principal,
            ...(key.collection ? { collection: key.collection } : {}),
            ...(key.remoteId === undefined ? {} : { remoteId: key.remoteId }),
            ...(typeof value.connectionId === 'string'
              ? { connectionId: value.connectionId }
              : {}),
          });
          // Already-adopted ancestors may still contain historical children.
          descend =
            key.kind !== 'record' ||
            ['githubOrganization', 'githubRepository'].includes(
              String(key.collection?.resource),
            );
        } else {
          if (
            row.get(nodeProperty) !== key.kind ||
            row.get(core.properties.localId) !==
              'syncables:node:' + encodeURIComponent(raw)
          ) {
            warn('A legacy source binding does not match its saved identity.');
            continue;
          }

          const value = row.get(p['syncable-source-config']);
          const config = record(value) ? value : {};
          const isPublic = key.kind.startsWith('public');
          const slot =
            typeof config.connectionId === 'string'
              ? config.connectionId
              : undefined;

          if (
            isPublic
              ? Object.hasOwn(config, 'connectionId') ||
                key.connectionId !== undefined
              : !slot ||
                (key.connectionId !== undefined && key.connectionId !== slot)
          ) {
            warn('A legacy source has conflicting authentication provenance.');
            continue;
          }

          historical.set(subject, {
            row,
            key,
            raw,
            config,
            slot,
            public: isPublic,
          });
          descend = true;
        }
      } catch {
        warn('A saved legacy source binding is malformed.');
        continue;
      }
    } else if (
      typeof row.get(core.properties.localId) === 'string' &&
      /^syncables:github-issue:[1-9][0-9]*$/.test(
        row.get(core.properties.localId) as string,
      )
    ) {
      flatIssues.set(subject, row);
    }

    if (!descend) continue;
    const children = await row.getChildrenCollection();
    await children.waitForReady();
    if (children.totalMembers > maximum)
      throw new Error('Legacy source migration exceeds its resource limit');

    for (let page = 0; page < children.totalPages; page++) {
      const members = await children.getMembersOnPage(page);
      for (const child of members) if (local(child)) pending.push(child);
      if (pending.length + visited.size > maximum)
        throw new Error('Legacy source migration exceeds its resource limit');
    }
  }

  if (!historical.size && !flatIssues.size)
    return { sources, warnings: [...warnings] };

  const principals = new Map<string, SyncablePrincipal>();

  if (options.principalProvenance) {
    const descriptions = options.principalDescriptions ?? [];

    for (const slot of new Set(
      [...historical.values()].flatMap(old => (old.slot ? [old.slot] : [])),
    )) {
      const proof = await options.principalProvenance(slot);
      if (!proof) continue;
      const durable = descriptions.filter(
        description =>
          description.identifier.stable === true &&
          description.identifier.reassigned === false,
      );

      if (proof.principal) {
        const declared = durable.filter(
          description =>
            description.namespace === proof.principal!.namespace &&
            (description.identifier.scope === 'provider' ||
              !!proof.principal!.clientContext),
        );
        if (declared.length === 1)
          principals.set(slot, principalIdentity(proof.principal));
        else
          warn(
            'A saved account identity does not match an unambiguous current catalog declaration.',
          );
      } else if (proof.legacyNumericSubject !== undefined) {
        const declared = durable.filter(
          description => description.identifier.scope === 'provider',
        );
        if (
          declared.length === 1 &&
          Number.isSafeInteger(proof.legacyNumericSubject)
        ) {
          principals.set(slot, {
            kind: 'authenticated',
            namespace: declared[0].namespace,
            subject: proof.legacyNumericSubject,
          });
        } else
          warn(
            'A saved numeric account identity has no unambiguous provider namespace.',
          );
      }
    }
  }

  const sameAccess = (
    old: HistoricalRow,
    slot: string | undefined,
    principal?: SyncablePrincipal,
  ) => {
    if (old.slot === slot) return true;
    const expected = old.slot && principals.get(old.slot);
    const actual = principal ?? (slot && principals.get(slot));

    return (
      !!expected &&
      !!actual &&
      sourceConfigFingerprint(expected) === sourceConfigFingerprint(actual)
    );
  };

  const bySubject = new Map<string, LegacySourceAlias>(modern);

  const parentOf = (
    old: HistoricalRow,
    kind: string,
    field?: string,
  ): string | undefined => {
    // A move changes navigation, not the historical remote binding. Resolve
    // only one exact source in the same credential context; never reparent it.
    const matches = [...historical.values()].filter(
      candidate =>
        candidate.key.kind === kind &&
        sameAccess(old, candidate.slot) &&
        candidate.public === old.public &&
        (!field ||
          (integer(candidate.config[field]) !== undefined &&
            integer(candidate.config[field]) === integer(old.config[field]))),
    );
    if (matches.length === 1) return matches[0].row.subject;
    const actual = old.row.get(core.properties.parent);
    const direct = typeof actual === 'string' ? modern.get(actual) : undefined;
    if (
      !matches.length &&
      direct &&
      sameAccess(old, direct.connectionId, direct.principal) &&
      (kind === 'organizations'
        ? direct.kind === 'collection' &&
          direct.collection?.resource === 'githubOrganization'
        : kind === 'repositories'
          ? direct.kind === 'collection' &&
            direct.collection?.resource === 'githubRepository'
          : direct.kind === 'record' &&
            direct.remoteId === integer(old.config[field!]))
    )
      return actual as string;
    // An adopted parent has a new key, but retains its typed remote identity.
    const adopted = [...modern.values()].filter(
      candidate =>
        candidate.kind ===
          (kind === 'organizations' || kind === 'repositories'
            ? 'collection'
            : 'record') &&
        sameAccess(old, candidate.connectionId, candidate.principal) &&
        (field
          ? candidate.remoteId === integer(old.config[field])
          : candidate.subject === actual),
    );
    if (!matches.length && adopted.length === 1) return adopted[0].subject;
    if (matches.length + adopted.length > 1)
      warn(
        'A historical source has ambiguous logical parents; no destination was selected.',
      );
  };

  const add = (
    old: HistoricalRow,
    value: Omit<LegacySourceAlias, 'subject'>,
  ) => {
    const alias: LegacySourceAlias = {
      subject: old.row.subject,
      sourceKey: old.raw,
      sourceConfigFingerprint: sourceConfigFingerprint(
        old.row.get(p['syncable-source-config']),
      ),
      localId: old.row.get(core.properties.localId) as string,
      ...(old.public
        ? { principal: { kind: 'public' as const } }
        : {
            connectionId: old.slot,
            ...(old.slot && principals.has(old.slot)
              ? { principal: principals.get(old.slot)! }
              : {}),
          }),
      ...value,
    };
    sources.push(alias);
    bySubject.set(alias.subject, alias);

    return alias;
  };

  // Historical names below are serialized format IDs, never mutable display names.
  const collection = (name: string, resource: string) => {
    const matches = collections.filter(
      item => item.name === name && item.resource === resource,
    );

    if (matches.length !== 1) {
      warn(
        'A historical collection has no unambiguous current catalog identity.',
      );

      return;
    }

    return matches[0];
  };

  const organizations = collection('githubOrganizations', 'githubOrganization');
  const repositories = collection('githubRepositories', 'githubRepository');
  const issues = collection('repositoryIssues', 'issue');

  const descriptor = (item: CollectionDescription, parentResource?: string) => {
    if (!parentResource)
      return { name: item.name, resource: item.resource, context: {} };
    const relations = item.relationships.filter(
      relation => relation.parentResource === parentResource,
    );

    if (relations.length !== 1) {
      warn(
        'A historical child collection has ambiguous catalog relationships.',
      );

      return;
    }

    const relation = relations[0];

    return {
      name: item.name,
      resource: item.resource,
      ...(relation.reference ? { reference: relation.reference } : {}),
      ...(relation.link ? { link: relation.link } : {}),
    };
  };

  for (const old of historical.values()) {
    if (old.key.kind === 'account' && old.key.identity === old.slot)
      add(old, { kind: 'principal' });
    if (old.key.kind === 'public' && old.key.identity === 'github-public')
      add(old, { kind: 'principal' });
    if (
      old.key.kind === 'organizations' &&
      old.key.identity === old.slot &&
      organizations
    )
      add(old, { kind: 'collection', collection: descriptor(organizations) });
  }

  for (const old of historical.values()) {
    if (old.key.kind !== 'owner') continue;
    const parent = parentOf(old, 'organizations');
    const ownerId = integer(old.config.ownerId);
    if (
      old.row.get(p['syncable-owner-kind']) === 'organization' &&
      ownerId &&
      old.key.identity === 'github-owner:' + ownerId &&
      typeof parent === 'string' &&
      bySubject.get(parent)?.kind === 'collection' &&
      organizations
    )
      add(old, {
        kind: 'record',
        collection: {
          name: organizations.name,
          resource: organizations.resource,
        },
        parentSourceSubject: parent,
        remoteId: ownerId,
      });
  }

  const personalTables = new Map<string, HistoricalRow[]>();

  for (const old of historical.values()) {
    if (old.key.kind !== 'repositories') continue;
    if (
      old.key.identity !== 'github-owner:' + integer(old.config.ownerId) ||
      old.key.collection !== ''
    )
      continue;
    const parent = parentOf(old, 'owner', 'ownerId');
    const owner =
      typeof parent === 'string' ? historical.get(parent) : undefined;
    const adoptedOwner =
      typeof parent === 'string' ? modern.get(parent) : undefined;
    const ownerRow = typeof parent === 'string' ? cache.get(parent) : undefined;
    if (
      !ownerRow ||
      (owner
        ? !sameAccess(old, owner.slot) ||
          owner.config.ownerId !== old.config.ownerId
        : !adoptedOwner ||
          !sameAccess(old, adoptedOwner.connectionId, adoptedOwner.principal) ||
          adoptedOwner.remoteId !== integer(old.config.ownerId))
    )
      continue;

    if (ownerRow.get(p['syncable-owner-kind']) === 'organization') {
      const candidates = collections.filter(
        item =>
          item.resource === 'githubRepository' &&
          item.relationships.some(
            relation => relation.parentResource === 'githubOrganization',
          ),
      );
      const target =
        candidates.length === 1
          ? descriptor(candidates[0], 'githubOrganization')
          : undefined;
      if (target && bySubject.has(ownerRow.subject))
        add(old, {
          kind: 'collection',
          collection: target,
          parentSourceSubject: ownerRow.subject,
        });
      else
        warn(
          'An organization repository table has no unambiguous current relationship.',
        );
    } else if (ownerRow.get(p['syncable-owner-kind']) === 'personal') {
      const tables = personalTables.get(old.slot!) ?? [];
      tables.push(old);
      personalTables.set(old.slot!, tables);
    } else {
      warn('A historical repository owner has no verified stored kind.');
    }
  }

  for (const tables of personalTables.values()) {
    if (tables.length === 1 && repositories) {
      const table = tables[0];
      const ownerSubject = parentOf(table, 'owner', 'ownerId');
      const owner = ownerSubject ? historical.get(ownerSubject) : undefined;
      const listingSubject = owner
        ? parentOf(owner, 'organizations')
        : undefined;
      const listing = listingSubject
        ? historical.get(listingSubject)
        : undefined;
      const accountSubject = listing ? parentOf(listing, 'account') : undefined;
      const account = accountSubject
        ? historical.get(accountSubject)
        : undefined;
      const accountParent = account?.row.get(core.properties.parent);
      const oldAccounts =
        typeof accountParent === 'string'
          ? cache.get(accountParent)
          : undefined;
      const atInstallation =
        sameSubject(accountParent, app) ||
        (oldAccounts?.get(core.properties.localId) === 'syncables:accounts' &&
          sameSubject(oldAccounts.get(core.properties.parent), app) &&
          oldAccounts.get(p['syncable-platform-id']) === platform &&
          oldAccounts.get(p['syncable-proxy-origin']) === proxyOrigin);
      const generatedChain =
        owner &&
        listing &&
        account &&
        atInstallation &&
        owner.key.identity ===
          'github-owner:' + integer(table.config.ownerId) &&
        listing.key.identity === table.slot &&
        account.key.identity === table.slot &&
        sameSubject(table.row.get(core.properties.parent), owner.row.subject) &&
        sameSubject(
          owner.row.get(core.properties.parent),
          listing.row.subject,
        ) &&
        sameSubject(
          listing.row.get(core.properties.parent),
          account.row.subject,
        );
      add(table, {
        kind: 'collection',
        collection: descriptor(repositories),
        ...(generatedChain
          ? { previousParent: owner.row.subject, reparentToLogicalParent: true }
          : {}),
      });
    } else
      warn(
        'Several historical repository tables compete for one root collection; no destination was selected.',
      );
  }

  for (const old of historical.values()) {
    if (old.key.kind !== 'repository') continue;
    const parent = parentOf(old, 'repositories', 'ownerId');
    const table =
      typeof parent === 'string' ? bySubject.get(parent) : undefined;
    const remoteId = integer(old.config.repoId);
    if (
      table?.kind === 'collection' &&
      table.collection &&
      remoteId &&
      old.key.identity === 'github-repo:' + remoteId
    )
      add(old, {
        kind: 'record',
        collection: {
          name: table.collection.name,
          resource: table.collection.resource,
        },
        remoteId,
        parentSourceSubject: parent as string,
      });
  }

  for (const old of historical.values()) {
    if (!['mirror', 'public-mirror'].includes(old.key.kind) || !issues)
      continue;
    const expected =
      (old.public ? 'github-public-repo:' : 'github-repo:') +
      integer(old.config.repoId);

    if (old.key.identity !== expected || old.key.collection !== 'issues') {
      warn(
        'A legacy mirror binding conflicts with its saved repository identity.',
      );
      continue;
    }

    if (old.public) {
      const repoId = integer(old.config.repoId);
      // Anonymous import used an explicit repository selection. Reuse the
      // canonical instance only when the current catalog declares that input.
      if (
        repoId &&
        issues.allowsAnonymous &&
        issues.contextParams.length === 1 &&
        issues.contextParams[0] === 'repository_id' &&
        old.key.identity === 'github-public-repo:' + repoId &&
        old.key.collection === 'issues'
      )
        add(old, {
          kind: 'collection',
          collection: {
            name: issues.name,
            resource: issues.resource,
            context: { repository_id: String(repoId) },
          },
        });
      else
        warn(
          'A historical Public mirror has no unambiguous anonymous catalog instance.',
        );
      continue;
    }

    const parent = parentOf(old, 'repository', 'repoId');
    const target = descriptor(issues, 'githubRepository');
    if (
      typeof parent === 'string' &&
      bySubject.get(parent)?.kind === 'record' &&
      target
    )
      add(old, {
        kind: 'collection',
        collection: target,
        parentSourceSubject: parent,
      });
    else
      warn(
        'A historical Issues mirror has no verified current parent collection; its saved data was retained.',
      );
  }

  for (const row of flatIssues.values()) {
    const parent = row.get(core.properties.parent);
    const table =
      typeof parent === 'string' ? bySubject.get(parent) : undefined;
    // Old localId uses the database id; current CRUD identity uses the issue number.
    const remoteId = integer(row.get(p['syncable-issue-number']));
    if (
      !table?.collection ||
      table.kind !== 'collection' ||
      !remoteId ||
      table.collection.resource !== 'issue'
    )
      continue;
    sources.push({
      subject: row.subject,
      localId: row.get(core.properties.localId) as string,
      kind: 'record',
      collection: {
        name: table.collection.name,
        resource: table.collection.resource,
      },
      ...(table.connectionId ? { connectionId: table.connectionId } : {}),
      ...(table.principal ? { principal: table.principal } : {}),
      parentSourceSubject: parent as string,
      remoteId,
      remoteIdProperty: p['syncable-issue-number'],
    });
  }

  const mapped = new Set(sources.map(source => source.subject));

  for (const old of historical.values()) {
    const retainedGrouping =
      (old.key.kind === 'owner' &&
        old.row.get(p['syncable-owner-kind']) === 'personal') ||
      ['public-owner', 'public-repository'].includes(old.key.kind);
    if (!mapped.has(old.row.subject) && !retainedGrouping)
      warn(
        'Some saved legacy sources cannot be mapped safely; new destinations are blocked until they are resolved.',
      );
  }

  for (const row of flatIssues.values())
    if (!mapped.has(row.subject))
      warn(
        'Some saved legacy records have no verified source identity; new destinations are blocked until they are resolved.',
      );

  return { sources, warnings: [...warnings] };
}
