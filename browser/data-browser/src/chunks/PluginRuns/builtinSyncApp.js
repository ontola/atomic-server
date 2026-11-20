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
} from 'syncables/browser';
import {
  canonicalValue,
  principalIdentity,
  sourceKey,
  sourceConfigFingerprint,
  entityTableKey,
  entitySourceKey,
  ruleSourceKey,
} from './builtinSyncIdentity.js';
import { reduceFlatState } from './builtinSyncFlatState.js';

const P = 'https://atomicdata.dev/properties/';
const core = Object.fromEntries(
  ['name', 'localId', 'parent', 'isA', 'classtype'].map(key => [key, P + key]),
);
const tableClass = 'https://atomicdata.dev/classes/Table';
const viewClass = 'https://atomicdata.dev/classes/View';
const tableViews = P + 'table-views';
const defaultView = P + 'table-default-view';
const viewKind = P + 'view-kind';
const same = (left, right) =>
  JSON.stringify(canonicalValue(left)) ===
  JSON.stringify(canonicalValue(right));

class PrincipalAuthorizationError extends Error {
  constructor(connectionId, expired) {
    super(
      expired
        ? 'This connection has expired. Connect the account again to restore access.'
        : 'This connection could not authorize its account. Connect again to restore access.',
    );
    this.connectionId = connectionId;
  }
}

/** Catalog interpretation belongs to Syncables; all I/O uses the shared app store. */
export function createSyncApp(store, context) {
  const root = context.subject;

  const property = name => {
    const subject = context.schema?.properties[name];
    if (!subject) throw new Error('The Sync schema is unavailable');

    return subject;
  };

  const klass = name => {
    const subject = context.schema?.classes[name];
    if (!subject) throw new Error('The Sync row schema is unavailable');

    return subject;
  };

  let document;

  const readDocument = () => {
    if (!context.document)
      throw new Error('The integration API description is unavailable');

    return (document ??= prepareDocument(context.document));
  };

  let catalog;
  const descriptions = () => (catalog ??= describeCollections(readDocument()));

  const description = name => {
    const matches = descriptions().filter(item => item.name === name);
    if (matches.length !== 1)
      throw new Error('Unknown or ambiguous collection ' + name);

    return matches[0];
  };

  const identity = values =>
    sourceKey({
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      principal: context.principal,
      ...values,
    });

  async function queryAll(args) {
    const subjects = [];

    for (let page = 0; page < 200; page++) {
      const chunk = await store.query({ ...args, page, pageSize: 100 });
      subjects.push(...chunk);
      if (chunk.length < 100) return [...new Set(subjects)];
    }

    throw new Error('Atomic query limit reached; cached rows were retained');
  }

  async function resources(args) {
    const subjects = await queryAll(args);
    const found = [];
    for (let i = 0; i < subjects.length; i += 100)
      found.push(
        ...(await store.getMany(subjects.slice(i, i + 100))).filter(
          row => !row.error,
        ),
      );

    return found;
  }

  async function withinRoot(subject) {
    const seen = new Set();

    for (let depth = 0; subject && depth < 64 && !seen.has(subject); depth++) {
      if (subject === root) return true;
      seen.add(subject);
      subject = (await store.getResource(subject)).get(core.parent);
    }

    return false;
  }

  async function patch(row, values, remove = []) {
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

  const legacyMatches = new Map();

  async function legacyNode(key, config, existingSubject) {
    const desired = JSON.parse(key);
    const matches = [];

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
            row.get(property('syncable-source-config')),
          ) !== alias.sourceConfigFingerprint)
      )
        throw new Error(
          'The older entity source changed; no duplicate was created',
        );
      matches.push(row);
      legacyMatches.set(row.subject, alias);
    }

    for (const alias of context.legacySources ?? []) {
      if (alias.subject === existingSubject) continue;
      if (
        alias.kind !== desired.kind ||
        !same(alias.collection, desired.collection) ||
        !same(alias.remoteId, desired.remoteId)
      )
        continue;
      if (
        alias.principal
          ? !same(principalIdentity(alias.principal), desired.principal)
          : !alias.connectionId || alias.connectionId !== config?.connectionId
      )
        continue;

      if (desired.parentSourceKeyHash) {
        const parent = alias.parentSourceSubject
          ? await store.getResource(alias.parentSourceSubject)
          : undefined;
        if (parent?.error)
          throw new Error('The legacy source parent could not be validated');
        const parentKey = parent
          ? parent.get(property('syncable-source-key'))
          : alias.parentSourceKey;
        if (!parentKey)
          throw new Error(
            'The legacy source parent needs adoption before syncing',
          );
        if (sourceConfigFingerprint(parentKey) !== desired.parentSourceKeyHash)
          continue;
      }

      const row = await store.getResource(alias.subject);
      if (
        row.error ||
        (alias.sourceKey !== undefined &&
          row.get(property('syncable-source-key')) !== alias.sourceKey) ||
        (alias.localId !== undefined &&
          row.get(core.localId) !== alias.localId) ||
        (alias.sourceConfigFingerprint !== undefined &&
          sourceConfigFingerprint(
            row.get(property('syncable-source-config')),
          ) !== alias.sourceConfigFingerprint) ||
        (alias.remoteIdProperty !== undefined &&
          row.get(alias.remoteIdProperty) !== alias.remoteId)
      )
        throw new Error(
          'The legacy source changed or could not be validated; no duplicate was created',
        );
      matches.push(row);
      legacyMatches.set(row.subject, alias);
    }

    if (new Set(matches.map(row => row.subject)).size > 1)
      throw new Error('The legacy source identity is ambiguous');

    return matches[0];
  }

  async function findNode(key, expectedClass, kind, config = context) {
    const aliases = context.identityAliases?.[key] ?? [];

    for (const candidate of [key, ...aliases]) {
      const matches = await resources({
        property: property('syncable-source-key'),
        value: candidate,
      });
      if (matches.length > 1)
        throw new Error('The source identity is ambiguous');
      if (!matches.length) continue;
      const row = matches[0];
      if (
        !row.hasClasses(expectedClass) ||
        (!aliases.includes(candidate) &&
          row.get(property('syncable-node-kind')) !== kind)
      )
        throw new Error('The source identity does not match its resource');

      if (candidate === key) {
        const desired = JSON.parse(key);

        if (
          desired.version === 3 &&
          ['collection', 'record'].includes(desired.kind)
        ) {
          const saved = row.get(property('syncable-source-config'));
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
      }

      if (await legacyNode(key, config, row.subject))
        throw new Error(
          'This account or collection has conflicting saved sources. Review its migration before syncing; all saved data was retained.',
        );

      return row;
    }

    return legacyNode(key, config);
  }

  async function updateNode(
    row,
    { key, kind, isA, values, parent },
    remove = [],
  ) {
    const migrated = row.get(property('syncable-source-key')) !== key;
    const alias = legacyMatches.get(row.subject);
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
        ...(migrated
          ? {
              [property('syncable-source-key')]: key,
              [property('syncable-node-kind')]: kind,
              [core.isA]: [...new Set([...(row.get(core.isA) ?? []), ...isA])],
            }
          : {}),
        ...(relocate ? { [core.parent]: parent } : {}),
        ...values,
      },
      remove,
    );
  }

  async function ensureViews(row) {
    const subjects = row.get(tableViews) ?? [];
    const definitions = await store.getMany(subjects);
    const kinds = definitions
      .filter(
        definition =>
          !definition.error &&
          definition.get(property('syncable-source-config'))?.kind !== 'rule',
      )
      .map(definition => definition.get(viewKind));
    const added = [];
    let browse;

    for (const [name, kind] of [
      ['Collection', 'syncable-collection'],
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
      if (kind === 'syncable-collection') browse = definition.subject;
    }

    if (added.length)
      await patch(row, {
        [tableViews]: [...subjects, ...added],
        ...(!row.get(defaultView) && browse ? { [defaultView]: browse } : {}),
      });
  }

  async function ensureNode({ key, kind, parent, name, isA, values = {} }) {
    let row = await findNode(
      key,
      isA[0],
      kind,
      values[property('syncable-source-config')],
    );

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
    const desired = JSON.parse(key);
    const block = (context.flatMigrationBlocks ?? []).find(
      item =>
        item.resource === desired.resource &&
        same(item.principal, desired.principal),
    );
    if (block) throw new Error(block.message);
    if (context.legacyMigrationBlocked)
      throw new Error(
        'Review the historical source warnings before creating another sync destination',
      );

    if (
      kind === 'principal' &&
      JSON.parse(key).principal.kind === 'authenticated'
    ) {
      for (const alias of context.legacySources ?? []) {
        if (alias.kind !== 'principal' || alias.principal) continue;
        const previous = await store.getResource(alias.subject);
        const config = previous.get(property('syncable-source-config'));
        const adopted =
          !previous.error &&
          config?.version === 2 &&
          config.principal?.kind === 'authenticated' &&
          previous.hasClasses(klass('syncable-principal')) &&
          previous.get(property('syncable-source-key')) ===
            identity({ kind: 'principal', principal: config.principal });
        if (!adopted)
          throw new Error(
            'Reconnect the saved account before creating another account. Its existing data has been retained.',
          );
      }
    }

    if (kind === 'collection' && desired.version === 3) {
      const previousTables = await resources({
        property: property('syncable-node-kind'),
        value: 'collection',
      });

      for (const previous of previousTables) {
        const config = previous.get(property('syncable-source-config'));
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

  async function transport(request, connectionId = context.connectionId) {
    if (context.principal?.kind === 'public') connectionId = undefined;
    const { url, method, body } = request;
    if (
      url.username ||
      url.password ||
      url.hash ||
      !['GET', 'POST'].includes(method)
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
    });

    if (request.purpose === 'principal' && response.status === 401)
      throw new PrincipalAuthorizationError(
        connectionId,
        response.body?.error === 'credential_refresh_failed',
      );

    return {
      status: response.status,
      headers: response.headers,
      body: JSON.stringify(response.body),
    };
  }

  const rowClass = collection => {
    const subject =
      context.apiSchema?.classes[ontologyShortname(collection.resource)];
    if (!subject) throw new Error('The catalog row schema is unavailable');

    return subject;
  };

  function collectionView(collection) {
    const columns = (collection.presentation?.columns ?? [])
      .flatMap(column => {
        const subject = context.apiSchema?.properties[column.property];

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
      title: collection.presentation?.title ?? collection.name,
      columns: columns.length
        ? columns
        : [{ property: core.name, label: 'Name' }],
      openTargetProperty: property('syncable-open-target'),
      ...(collection.relationships
        ? { relationships: collection.relationships }
        : {}),
    };
  }

  const entityTypes = () => describeEntityTypes(readDocument());

  const entityType = resource => {
    const found = entityTypes().find(item => item.resource === resource);
    if (!found) throw new Error('Unknown catalog entity type');

    return found;
  };

  async function ensureEntityTable({
    parent = root,
    principal = context.principal,
    connectionId = context.connectionId,
    resource,
  }) {
    const type = entityType(resource);
    const key = entityTableKey({ ...context, principal, resource });
    const adoptionRules = (context.flatAdoptionRules ?? []).filter(
      item => item.tableSourceKey === key,
    );

    if (adoptionRules.length) {
      const previous = await findNode(key, tableClass, 'collection', {
        principal,
        connectionId,
      });

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
        row.get(property('syncable-source-config'))?.kind === 'rule',
    );
  }

  async function ensureRule(table, definition, name, tableSourceKey) {
    compileReadSelection(readDocument(), definition, {
      querySelection: context.querySelection,
    });
    const ruleKey = readSelectionKey(definition);
    if (typeof ruleKey !== 'string' || !ruleKey)
      throw new Error('The catalog selection has no stable rule key');
    const key = ruleSourceKey(
      tableSourceKey ?? table.get(property('syncable-source-key')),
      ruleKey,
    );
    const rule = await ensureNode({
      key,
      kind: 'rule',
      parent: table.subject,
      name: name || entityType(definition.resource).presentation.title,
      isA: [viewClass],
      values: {
        [viewKind]: 'syncable-collection',
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
      (await store.getResource(table.subject)).get(tableViews) ?? [];
    if (!views.includes(rule.subject))
      await patch(table, { [tableViews]: [...views, rule.subject] });

    return rule;
  }

  async function adoptFlatRows(principal) {
    for (const alias of context.flatIdentityAliases ?? []) {
      const config = alias.canonicalConfig;
      if (
        !config ||
        config.kind !== 'record' ||
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
        alias.entityTableSourceKey,
        tableClass,
        'collection',
        config,
      );
      if (!table)
        throw new Error('Adopt the entity collection before its saved rows');
      const row = await findNode(
        alias.canonicalSourceKey,
        rowClass(entityType(config.resource)),
        'record',
        config,
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

  async function discoverCollections(principalTable, principal, connectionId) {
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
          (type.presentation?.title ?? type.resource) +
            ': ' +
            String(error?.message ?? error),
        );
      }
    }

    try {
      await adoptFlatRows(principal);
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }

    if (errors.length) throw new Error(errors.join('; ').slice(0, 2048));

    return created;
  }

  async function installedPrincipal(principal) {
    const matches = (context.principalApps ?? []).filter(ref =>
      same(ref.principal, principal),
    );
    if (matches.length > 1)
      throw new Error('The installed principal identity is ambiguous');
    if (!matches.length) return;
    const row = await store.getResource(matches[0].subject);
    const config = row.get(property('syncable-source-config'));
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

  async function openPrincipal(connectionId, navigate = true) {
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
    const principal = { kind: 'public' };
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
    name,
    parameters = {},
    sourcePath,
    filterName,
  ) {
    if (!['principal', 'collection'].includes(context.kind))
      throw new Error('Choose a principal first');
    const collection = description(name);
    if (context.principal.kind === 'public' && !collection.allowsAnonymous)
      throw new Error('This collection requires an authenticated principal');
    if (
      context.kind === 'collection' &&
      (sourcePath || collection.contextParams.length)
    )
      throw new Error(
        'Choose this parameterized source from the principal first',
      );
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
    if (
      context.kind === 'collection' &&
      collection.resource !== context.resource
    )
      throw new Error('Choose a source for this entity collection');
    const rule = await ensureRule(
      table,
      {
        version: 1,
        resource: collection.resource,
        source: { kind: 'bound', bound },
      },
      filterName || collection.presentation.title,
    );
    await store.ui.openResource(rule.subject);

    return rule;
  }

  const statusSubject = () => context.rule?.subject ?? root;

  async function status() {
    const value = (await store.getResource(statusSubject())).get(
      property('syncable-mirror-status'),
    );

    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  async function saveStatus(values) {
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
    const rule = await store.getResource(context.rule.subject);
    const config = rule.get(property('syncable-source-config'));
    if (
      config?.ruleKey !== context.rule.key ||
      readSelectionKey(config.definition) !== context.rule.key
    )
      throw new Error('The saved filter definition changed');

    return run;
  }

  async function durableResource(kind, parent, id, payload) {
    await assertRun();
    const existing = await resources({ property: core.localId, value: id });
    if (existing.length > 1)
      throw new Error('The durable sync evidence identity is ambiguous');

    if (existing.length) {
      if (!(await withinRoot(existing[0].subject)))
        throw new Error('The sync evidence moved outside this table');

      const previous = existing[0].get(property(kind));
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
    const runs = [],
      observations = [];

    for (const rule of await savedRules()) {
      for (const row of await resources({
        property: core.parent,
        value: rule.subject,
      })) {
        const run = row.get(property('syncable-sync-run'));
        if (run) runs.push(run);
        const observation = row.get(property('syncable-observation'));
        if (observation) observations.push(observation);
      }
    }

    return { runs, observations };
  }

  async function reconcile() {
    const evidence = await ledger();
    const state = reduceFlatState(evidence);
    const latest = new Map();
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

    const counts = { added: 0, changed: 0, unchanged: 0 };

    for (const [key, reduced] of Object.entries(state)) {
      await assertRun();
      const item = latest.get(key)?.observation;
      if (!item) continue;
      const old = await findNode(
        key,
        rowClass(entityType(context.resource)),
        'record',
      );
      const values = Object.fromEntries(
        Object.entries(reduced.values).map(([name, value]) => {
          const subject = context.apiSchema?.properties[name];
          if (!subject)
            throw new Error('The catalog property schema is unavailable');

          return [subject, value];
        }),
      );
      const removed = reduced.cleared
        .map(name => context.apiSchema?.properties[name])
        .filter(Boolean);
      const recordConfig = {
        version: 3,
        kind: 'record',
        proxyOrigin: context.proxyOrigin,
        platform: context.platform,
        principal: context.principal,
        resource: context.resource,
        entityIdentity: item.entity,
        record: reduced.raw ?? item.raw,
        context: item.context,
        read: item.provenance.read,
        managedProperties: Object.keys(values),
      };
      const intents = relatedCollectionReads(readDocument(), {
        resource: context.resource,
        record: reduced.raw ?? item.raw,
        context: item.provenance.read.pathParams,
      }).map(navigation => ({
        version: 1,
        resource: navigation.resource,
        sourceEntityKey: key,
        label: description(navigation.collection).presentation.title,
        definition: {
          version: 1,
          resource: navigation.resource,
          source: {
            kind: 'related',
            origin: {
              entity: item.entity,
              record: reduced.raw ?? item.raw,
              context: item.context,
              read: item.provenance.read,
            },
            via: {
              collection: navigation.collection,
              kind:
                navigation.kind === 'responseLink'
                  ? 'responseLink'
                  : 'identity',
              ...(navigation.reference
                ? { reference: navigation.reference }
                : {}),
              ...(navigation.link ? { link: navigation.link } : {}),
            },
          },
        },
      }));
      let name = item.projected.name;

      if (name === item.projected.id) {
        const label = entityType(context.resource).presentation.columns.find(
          column =>
            typeof reduced.values[column.property] === 'string' &&
            reduced.values[column.property].trim(),
        );
        if (label) name = reduced.values[label.property];
      }

      const rowValues = {
        [core.name]: name,
        ...values,
        [property('syncable-entity-table')]: root,
        [property('syncable-rule-memberships')]: reduced.memberships,
        [property('syncable-source-config')]: recordConfig,
        [property('syncable-navigation-intents')]: intents,
      };

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
              isA: [
                rowClass(entityType(context.resource)),
                klass('syncable-record'),
              ],
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
          isA: [
            rowClass(entityType(context.resource)),
            klass('syncable-record'),
          ],
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
    let run = {
      ruleSubject: context.rule.subject,
      ruleKey: context.rule.key,
      ...stamp,
      complete: false,
      entityKeys: [],
    };
    const id =
      'syncables:run:' +
      sourceConfigFingerprint([context.rule.subject, stamp.runId]);
    const storedRun = await durableResource(
      'syncable-sync-run',
      context.rule.subject,
      id,
      run,
    );

    try {
      const result = await readSelection(
        readDocument(),
        context.rule.definition,
        {
          transport,
          querySelection: context.querySelection,
          maxPartitions: 32,
          limits: {
            maxRequests: context.principal.kind === 'public' ? 40 : 20,
            maxRecords: 4000,
            timeoutMs: 120000,
            maxRetries: 0,
          },
        },
      );
      await assertRun();
      const accepted = result.observations.map(observation => ({
        ...observation,
        entityKey: entitySourceKey({
          ...context,
          entityIdentity: observation.entity,
        }),
        ruleKey: context.rule.key,
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
          context.rule.subject,
          'syncables:observation:' +
            sourceConfigFingerprint([
              context.rule.subject,
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
        .then(() =>
          saveStatus({ error: String(error?.message ?? error).slice(0, 1024) }),
        )
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
        const config = saved[i].get(property('syncable-source-config'));
        if (same(config?.principal, ref.principal)) saved.splice(i, 1);
      }

      saved.push(row);
    }

    for (const alias of context.legacySources ?? []) {
      if (
        alias.kind !== 'principal' ||
        saved.some(row => row.subject === alias.subject)
      )
        continue;
      const row = await store.getResource(alias.subject);
      if (!row.error) saved.push(row);
    }

    return saved;
  }

  async function discoverPrincipals() {
    const connections = await store.proxy.connections({
      platform: context.platform,
    });
    const saved = await storedPrincipals();
    const known = new Set();
    const errors = [];
    const authorizationRequired = [];

    for (const row of saved) {
      const config = row.get(property('syncable-source-config'));
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
          config,
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

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;

  return node;
}

/** Opening Sync reads saved state; provider requests require an explicit action. */
export async function view({ root, store }) {
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

  const showError = reason => {
    root.querySelector('[data-sync-error]')?.remove();
    const message = el('p', String(reason?.message ?? reason), 'error');
    message.setAttribute('role', 'alert');
    message.setAttribute('data-sync-error', '');
    root.prepend(message);
  };

  const button = (label, action) => {
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
    (context.legacyWarnings ?? [])
      .filter(message => typeof message === 'string')
      .slice(0, 20)
      .map(message => {
        const node = el('p', message.slice(0, 2048), 'muted');
        node.setAttribute('role', 'status');

        return node;
      });

  if (context.kind === 'platform') {
    let discovery;
    const errors = [];

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
        principal.get(context.schema.properties['syncable-source-config'])
          ?.principal?.kind === 'public',
    );

    const connect = async connectionId => {
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
          principal.get(context.schema.properties['syncable-source-config'])
            ?.principal?.kind === 'public',
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
            .map(error => String(error?.message ?? error))
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
    if (context.kind === 'collection') {
      root.append(el('h3', 'Saved filters'));
      for (const rule of await app.savedRules())
        root.append(
          button(rule.get(core.name), () =>
            store.ui.openResource(rule.subject),
          ),
        );
      root.append(
        el(
          'p',
          'All cached rows remain available in Collection. Each saved filter syncs independently.',
          'muted',
        ),
      );
      root.append(
        button('Choose source', async () =>
          store.ui.openResource(
            (await store.getResource(context.subject)).get(core.parent),
          ),
        ),
      );
      root.append(...warnings());

      return;
    }

    root.append(el('h3', 'Save a filter'));
    const filterName = el('input');
    filterName.setAttribute('aria-label', 'Filter name');
    filterName.placeholder = 'Filter name';
    const select = el('select');
    select.setAttribute('aria-label', 'Source collection');
    const inputs = el('div');
    const definitions = app
      .availableCollections()
      .filter(item => !context.resource || item.resource === context.resource);
    const entrypoint = el('select');
    entrypoint.setAttribute('aria-label', 'Source');

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

    const renderInputs = () => {
      inputs.replaceChildren();
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
      entrypoint.hidden = !sources.length;
      renderInputs();
    };

    select.addEventListener('change', renderEntrypoints);
    entrypoint.addEventListener('change', renderInputs);
    renderEntrypoints();
    controls.append(
      filterName,
      select,
      entrypoint,
      button('Save filter', () =>
        app.createCollection(
          select.value,
          Object.fromEntries(
            [...inputs.querySelectorAll('input')].map(input => [
              input.name,
              input.value,
            ]),
          ),
          entrypoint.value || undefined,
          filterName.value.trim() || undefined,
        ),
      ),
    );
    root.append(controls, inputs);
    root.append(...warnings());

    return;
  }

  let timer;

  const render = async () => {
    clearTimeout(timer);
    const execution = await store.execution('state');
    const status = await app.status();
    root.replaceChildren(el('h3', 'Saved filter sync'));
    controls.replaceChildren();
    const start = button(
      execution.queued ? 'Queued' : execution.running ? 'Syncing' : 'Sync now',
      async () => {
        await store.execution('start');
        await render();
      },
    );
    start.disabled = execution.running || execution.queued || status.paused;
    controls.append(
      start,
      button(status.paused ? 'Resume' : 'Pause', async () => {
        if (!status.paused) await store.execution('cancel');
        await app.saveStatus({ paused: !status.paused });
        await render();
      }),
    );
    if (context.connectionId)
      controls.append(
        button('Reconnect', () =>
          store.proxy.connect({
            platform: context.platform,
            connectionId: context.connectionId,
          }),
        ),
      );
    controls.append(
      button('Browse stored data', () =>
        store.ui.openResource(context.rule.subject),
      ),
    );
    const selected = await store.getResource(context.rule.subject);
    root.append(
      el('p', selected.get(core.name)),
      controls,
      el('p', (status.rows ?? 0) + ' stored entries'),
      el(
        'p',
        'Last successful sync: ' + (status.lastSuccess ?? 'Never'),
        'muted',
      ),
    );
    if (status.lastSuccess || status.incomplete)
      root.append(
        el(
          'p',
          `${status.added ?? 0} added · ${status.changed ?? 0} changed · ${status.unchanged ?? 0} unchanged`,
          'muted',
        ),
      );
    if (status.error) showError(status.error);
    root.append(...warnings());
    if (execution.running || execution.queued)
      timer = setTimeout(() => void render().catch(showError), 500);
  };

  await render();
}
