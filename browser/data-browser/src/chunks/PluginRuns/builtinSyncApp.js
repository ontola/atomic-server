// @wc-ignore-file
import {
  prepareDocument,
  describeCollections,
  bindCollection,
  bindCollectionNavigation,
  relatedCollectionReads,
  resolveCollectionNavigation,
  readBoundCollection,
  resolveAuthenticatedPrincipal,
  projectReadRecord,
  ontologyShortname,
  deriveOntology,
} from 'syncables/browser';
import {
  canonicalValue,
  collectionIdentity,
  principalIdentity,
  sourceKey,
  sourceConfigFingerprint,
} from './builtinSyncIdentity.js';

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

  const configuration = values => {
    const principal = principalIdentity(values.principal ?? context.principal);

    return {
      version: 2,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      ...(principal.kind !== 'public' && context.connectionId
        ? { connectionId: context.connectionId }
        : {}),
      ...values,
      principal,
    };
  };

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
      .filter(definition => !definition.error)
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
    };
  }

  async function ensureCollection({
    parent = root,
    principal = context.principal,
    connectionId = context.connectionId,
    bound,
    navigation,
    parentSourceKey,
  }) {
    const collection = description(bound?.collection ?? navigation.collection);
    const key = identity({
      kind: 'collection',
      principal,
      collection: collectionIdentity(bound, navigation),
      parentSourceKey,
    });

    return ensureNode({
      key,
      kind: 'collection',
      parent,
      name: collection.presentation?.title ?? collection.name,
      isA: [tableClass],
      values: {
        [core.classtype]: rowClass(collection),
        [property('syncable-source-config')]: configuration({
          principal: principalIdentity(principal),
          ...(principal.kind !== 'public' && connectionId
            ? { connectionId }
            : {}),
          ...(bound ? { collection: bound } : {}),
          ...(navigation ? { navigation } : {}),
          ...(parentSourceKey ? { parentSourceKey } : {}),
        }),
        [property('syncable-collection-view')]: collectionView(collection),
      },
    });
  }

  async function discoverCollections(principalTable, principal, connectionId) {
    const created = [];

    for (const collection of descriptions()) {
      // Unbound roots are available immediately; parameterized instances are explicit form choices.
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
      created.push(
        await ensureCollection({
          parent: principalTable.subject,
          principal,
          connectionId,
          bound,
        }),
      );
    }

    return created;
  }

  async function openPrincipal(connectionId, navigate = true) {
    const principal = await resolveAuthenticatedPrincipal(readDocument(), {
      clientContext: context.clientContext,
      transport: request => transport(request, connectionId),
    });
    const durable = principalIdentity(principal);
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

  async function createCollection(name, parameters = {}, sourcePath) {
    if (context.kind !== 'principal')
      throw new Error('Choose a principal first');
    if (
      context.principal.kind === 'public' &&
      !description(name).allowsAnonymous
    )
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
    const row = await ensureCollection({ bound });
    await store.ui.openResource(row.subject);

    return row;
  }

  async function status() {
    const value = (await store.getResource(root)).get(
      property('syncable-mirror-status'),
    );

    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  async function saveStatus(values) {
    await patch(await store.getResource(root), {
      [property('syncable-mirror-status')]: { ...(await status()), ...values },
    });
  }

  async function refresh() {
    if (context.kind !== 'collection')
      throw new Error('Select a collection to sync');
    if ((await status()).paused) throw new Error('Resume before syncing');

    try {
      const doc = readDocument();
      const resolved = context.navigation
        ? await resolveCollectionNavigation(doc, context.navigation, {
            transport,
          })
        : context.collection;
      const bound =
        context.navigation && resolved
          ? bindCollection(doc, {
              collection: resolved.collection,
              context: resolved.pathParams,
              selection: context.querySelection,
            })
          : resolved;
      if (!bound) throw new Error('The collection has no saved source binding');
      const definition = description(bound.collection);
      const result = await readBoundCollection(doc, bound, {
        transport,
        limits: {
          maxRequests: context.principal.kind === 'public' ? 40 : 20,
          maxRecords: 4000,
          timeoutMs: 120000,
          maxRetries: 0,
        },
      });
      const snapshot = result.collections[0];
      if (!snapshot)
        throw new Error(result.errors[0] ?? 'The collection was not read');
      if (snapshot.error && !snapshot.items.length)
        throw new Error(snapshot.error);
      const tableKey =
        context.sourceKey ??
        identity({
          kind: 'collection',
          collection: collectionIdentity(bound, context.navigation),
          parentSourceKey: context.parentSourceKey,
        });
      const ontology = deriveOntology(doc);
      const counts = { added: 0, changed: 0, unchanged: 0 };
      const seen = new Set();
      // Validate/project the full accepted prefix before writing any record in it.
      const accepted = snapshot.items.map(record => {
        const remoteId = record[definition.idField];
        if (
          !(
            (typeof remoteId === 'string' && remoteId.length) ||
            (typeof remoteId === 'number' && Number.isSafeInteger(remoteId))
          )
        )
          throw new Error('The catalog record has no stable typed identity');
        const projected = projectReadRecord(doc, {
          collection: definition,
          record,
          context: bound.pathParams,
          ontology,
        });

        if (projected.name === projected.id) {
          const label = definition.presentation.columns.find(
            column =>
              column.datatype === 'https://atomicdata.dev/datatypes/string' &&
              typeof projected.values[column.property] === 'string' &&
              projected.values[column.property].trim(),
          );
          if (label) projected.name = projected.values[label.property];
        }

        const values = Object.fromEntries(
          Object.entries(projected.values).map(([name, value]) => {
            const subject = context.apiSchema?.properties[name];
            if (!subject)
              throw new Error('The catalog property schema is unavailable');

            return [subject, value];
          }),
        );

        return { record, remoteId, projected, values };
      });

      for (const { record, remoteId, projected, values } of accepted) {
        const key = identity({
          kind: 'record',
          parentSourceKey: tableKey,
          collection: { name: bound.collection, resource: bound.resource },
          remoteId,
        });
        if (seen.has(key)) continue;
        seen.add(key);
        const old = await findNode(key, rowClass(definition), 'record');
        const rowValues = {
          [core.name]: projected.name,
          ...values,
          [property('syncable-source-config')]: configuration({
            parentSourceKey: tableKey,
            record,
            resource: definition.resource,
            context: bound.pathParams,
            managedProperties: Object.keys(values),
          }),
        };
        let row;

        if (old) {
          const previous = old.get(
            property('syncable-source-config'),
          )?.managedProperties;
          const allowed = new Set(Object.values(context.apiSchema.properties));
          const removed = Array.isArray(previous)
            ? previous.filter(
                subject =>
                  allowed.has(subject) && !Object.hasOwn(values, subject),
              )
            : [];
          counts[
            (await updateNode(
              old,
              {
                key,
                kind: 'record',
                isA: [rowClass(definition), klass('syncable-record')],
                values: rowValues,
              },
              removed,
            ))
              ? 'changed'
              : 'unchanged'
          ]++;
          row = old;
        } else {
          row = await ensureNode({
            key,
            kind: 'record',
            parent: root,
            name: projected.name,
            isA: [rowClass(definition), klass('syncable-record')],
            values: rowValues,
          });
          counts.added++;
        }

        if (!(await withinRoot(row.subject))) continue;
        const children = relatedCollectionReads(doc, {
          resource: definition.resource,
          record,
          context: bound.pathParams,
        });
        const targets = [];
        for (const navigation of children)
          targets.push(
            await ensureCollection({
              parent: row.subject,
              navigation,
              parentSourceKey: key,
            }),
          );
        // One saved link can open one child directly. With several, Open shows the row's child tables.
        if (targets.length === 1 && targets[0].get(core.parent) === row.subject)
          await patch(row, {
            [property('syncable-open-target')]: targets[0].subject,
          });
      }

      await patch(await store.getResource(root), {
        [core.classtype]: rowClass(definition),
        [property('syncable-collection-view')]: collectionView(definition),
      });
      const incomplete = !snapshot.complete;
      const summary = {
        ...counts,
        rows: seen.size,
        incomplete,
        error:
          snapshot.error ??
          snapshot.notComplete ??
          (incomplete
            ? 'The collection read was incomplete. Local rows were retained.'
            : null),
      };
      await saveStatus({
        ...summary,
        ...(!incomplete ? { lastSuccess: new Date().toISOString() } : {}),
      });

      return summary;
    } catch (error) {
      await saveStatus({
        error: String(error?.message ?? error).slice(0, 1024),
      }).catch(() => undefined);
      throw error;
    }
  }

  async function storedPrincipals() {
    const saved = (
      await resources({ property: core.parent, value: root })
    ).filter(row => row.hasClasses(klass('syncable-principal')));

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

      try {
        await findNode(
          identity({ kind: 'principal', principal: config.principal }),
          tableClass,
          'principal',
          config,
        );
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
    ensureCollection,
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

  if (context.kind === 'principal') {
    root.append(el('h3', 'Available collections'));
    const select = el('select');
    select.setAttribute('aria-label', 'Collection');
    const inputs = el('div');
    const definitions = app.availableCollections();
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
      select,
      entrypoint,
      button('Open collection', () =>
        app.createCollection(
          select.value,
          Object.fromEntries(
            [...inputs.querySelectorAll('input')].map(input => [
              input.name,
              input.value,
            ]),
          ),
          entrypoint.value || undefined,
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
    root.replaceChildren(el('h3', 'Collection sync'));
    controls.replaceChildren();
    const start = button(
      execution.running ? 'Syncing' : 'Sync now',
      async () => {
        await store.execution('start');
        await render();
      },
    );
    start.disabled = execution.running || status.paused;
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
      button('Browse stored data', async () => {
        const table = await store.getResource(context.subject);
        const definitions = await store.getMany(table.get(tableViews) ?? []);
        const target = definitions.find(
          row => !row.error && row.get(viewKind) === 'syncable-collection',
        );
        await store.ui.openResource(target?.subject ?? context.subject);
      }),
    );
    root.append(
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
    if (execution.running)
      timer = setTimeout(() => void render().catch(showError), 500);
  };

  await render();
}
