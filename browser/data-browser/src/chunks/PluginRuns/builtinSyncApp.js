// @wc-ignore-file
import {
  prepareDocument,
  describePlatform,
  readCollections,
} from 'syncables/browser';

/** Server-delivered GitHub sync app. All I/O uses the shared app bridge. */
const P = 'https://atomicdata.dev/properties/';
const core = Object.fromEntries(
  ['name', 'localId', 'parent', 'isA', 'classtype'].map(key => [key, P + key]),
);
const tableClass = 'https://atomicdata.dev/classes/Table';
const viewClass = 'https://atomicdata.dev/classes/View';
const tableViews = P + 'table-views';
const defaultView = P + 'table-default-view';
const viewKind = P + 'view-kind';
const validId = value =>
  Number.isSafeInteger(Number(value)) && /^[1-9][0-9]*$/.test(String(value));
const validLogin = value =>
  typeof value === 'string' &&
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(value);
const validRepo = value =>
  typeof value === 'string' &&
  /^[a-z0-9._-]{1,100}$/i.test(value) &&
  !['.', '..'].includes(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function sourceKeys(
  origin,
  kind,
  remoteId,
  connectionId,
  collection = '',
) {
  const identity = [origin, 'github-issues', kind, remoteId, collection];
  const legacy = JSON.stringify(identity);

  return kind === 'repositories' || kind === 'mirror'
    ? [JSON.stringify([...identity, connectionId]), legacy]
    : [legacy];
}

/** Domain logic stays in the sync app; its store has host-selected write bounds. */
export function createSyncApp(store, context) {
  const terms = context.schema;

  const property = name => {
    const subject = terms.properties[name];
    if (!subject) throw new Error('The GitHub schema is unavailable');

    return subject;
  };

  const klass = name => {
    const subject = terms.classes[name];
    if (!subject) throw new Error('The GitHub row schema is unavailable');

    return subject;
  };

  const origin = context.proxyOrigin;
  const root = context.subject;

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

    for (let depth = 0; subject && depth < 32 && !seen.has(subject); depth++) {
      if (subject === root) return true;
      seen.add(subject);
      subject = (await store.getResource(subject)).get(core.parent);
    }

    return false;
  }

  async function patch(row, values) {
    // Finding a moved resource is not permission to update it from its old parent.
    if (!(await withinRoot(row.subject))) return false;
    const changed = Object.entries(values).filter(
      ([key, value]) => value !== undefined && !same(row.get(key), value),
    );
    for (const [key, value] of changed) row.set(key, value);
    if (changed.length) await row.save();

    return changed.length > 0;
  }

  async function findNode(keys) {
    for (const key of keys) {
      const subjects = await store.query({
        property: core.localId,
        value: 'syncables:node:' + encodeURIComponent(key),
      });
      if (subjects.length > 1)
        throw new Error('The GitHub source identity is ambiguous');

      if (subjects.length) {
        const found = await store.getResource(subjects[0]);
        const [, , kind, remoteId] = JSON.parse(keys[0]);
        if (
          found.error ||
          !keys.includes(found.get(property('syncable-source-key'))) ||
          found.get(property('syncable-node-kind')) !== kind ||
          ([
            'organizations',
            'repositories',
            'mirror',
            'public',
            'public-mirror',
          ].includes(kind) &&
            !found.hasClasses(tableClass))
        )
          throw new Error(
            'The GitHub source identity does not match its resource',
          );
        const config = found.get(property('syncable-source-config'));
        if (
          keys.length > 1 &&
          (config?.connectionId !== JSON.parse(keys[0])[5] ||
            remoteId !==
              (kind === 'repositories'
                ? 'github-owner:' + config?.ownerId
                : 'github-repo:' + config?.repoId))
        )
          continue;

        return found;
      }
    }
  }

  async function ensureViews(row) {
    const subjects = row.get(tableViews) ?? [];
    const definitions = await store.getMany(subjects);
    const kinds = definitions
      .filter(definition => !definition.error)
      .map(definition => definition.get(viewKind));
    const added = [];
    let sync;

    for (const [name, kind] of [
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
      if (kind === 'syncables') sync = definition.subject;
    }

    if (added.length)
      await patch(row, {
        [tableViews]: [...subjects, ...added],
        ...(!subjects.length && !row.get(defaultView) && sync
          ? { [defaultView]: sync }
          : {}),
      });
  }

  async function ensureNode({
    kind,
    remoteId,
    name,
    parent,
    config,
    ownerKind,
    collection = '',
    metadata = {},
  }) {
    const keys = sourceKeys(
      origin,
      kind,
      remoteId,
      config?.connectionId,
      collection,
    );
    let row = await findNode(keys);
    const isTable = [
      'organizations',
      'repositories',
      'mirror',
      'public',
      'public-mirror',
    ].includes(kind);

    if (row) {
      await patch(row, metadata);

      return row;
    }

    if (!(await withinRoot(parent)))
      throw new Error(
        'Open the moved GitHub resource to sync at its current location',
      );
    const rowClass =
      kind === 'organizations' || kind === 'public'
        ? klass('syncable-owner')
        : kind === 'repositories'
          ? klass('syncable-repository')
          : klass('syncable-record');
    const ownClass =
      kind === 'account'
        ? klass('syncable-account')
        : kind === 'owner' || kind === 'public-owner'
          ? klass('syncable-owner')
          : klass('syncable-repository');
    row = await store.newResource({
      parent,
      isA: [isTable ? tableClass : ownClass],
      propVals: {
        [core.name]: name,
        [core.localId]: 'syncables:node:' + encodeURIComponent(keys[0]),
        [property('syncable-source-key')]: keys[0],
        [property('syncable-node-kind')]: kind,
        ...(config ? { [property('syncable-source-config')]: config } : {}),
        ...(ownerKind ? { [property('syncable-owner-kind')]: ownerKind } : {}),
        ...(isTable ? { [core.classtype]: rowClass } : {}),
        ...metadata,
      },
    });
    if (isTable) await ensureViews(row);

    return row;
  }

  async function request(
    path,
    { connectionId = context.connectionId, query } = {},
  ) {
    const response = await store.proxy.request({
      platform: 'github-issues',
      connectionId,
      method: 'GET',
      path,
      query,
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error('GitHub read failed (HTTP ' + response.status + ').');

    return response;
  }

  let document;

  function readDocument() {
    if (!document) {
      if (!context.document)
        throw new Error('The integration API description is unavailable');
      document = prepareDocument(context.document);
      const description = describePlatform(document);
      if (new URL(description.upstream).href !== 'https://api.github.com/')
        throw new Error('The GitHub API description has an unexpected server');
    }

    return document;
  }

  async function readCollection(
    name,
    connectionId = context.connectionId,
    optional = false,
  ) {
    const doc = readDocument();
    if (!describePlatform(doc).collections.includes(name))
      throw new Error('The API description has no collection ' + name);
    const result = await readCollections(doc, {
      collectionNames: [name],
      constants: context.repoId ? { repository_id: context.repoId } : {},
      selection: context.querySelection,
      limits: {
        maxRequests: context.mode === 'public' ? 40 : 20,
        maxRecords: 4000,
        timeoutMs: 120000,
        maxRetries: 0,
      },
      transport: async ({ url, method, body }) => {
        if (
          url.origin !== 'https://api.github.com' ||
          url.username ||
          url.password ||
          url.hash ||
          method !== 'GET' ||
          body !== undefined
        )
          throw new Error('This Sync app only reads the selected GitHub API');
        const query = Object.fromEntries(url.searchParams);
        if (Object.keys(query).length !== [...url.searchParams].length)
          throw new Error('Repeated GitHub query parameters are not supported');
        const response = await request(url.pathname.slice(1), {
          connectionId,
          query,
        });

        return {
          status: response.status,
          headers: response.headers,
          body: JSON.stringify(response.body),
        };
      },
    });
    const snapshot = result.collections.find(
      entry => entry.collection.name === name,
    );
    if (!snapshot)
      throw new Error(
        result.errors[0] ?? 'The selected collection was not read',
      );
    if (snapshot.error && !snapshot.items.length && !optional)
      throw new Error(snapshot.error);

    return snapshot;
  }

  function readState(...snapshots) {
    const error = snapshots
      .map(snapshot => snapshot.error ?? snapshot.notComplete)
      .filter(Boolean)
      .join('; ');

    return {
      incomplete: snapshots.some(snapshot => !snapshot.complete),
      ...(error ? { error } : {}),
    };
  }

  async function collectionView(table, rowClass, title, columns) {
    await patch(table, {
      [property('syncable-collection-view')]: {
        version: 1,
        rowClass: klass(rowClass),
        title,
        columns,
        openTargetProperty: property('syncable-open-target'),
      },
    });
  }

  function collectionSchema(collection) {
    const schema =
      readDocument().components?.crudResources?.[collection.resource]?.schema;
    if (!schema?.properties)
      throw new Error('The selected collection has no row schema');

    return schema;
  }

  // Only the field-to-Atomic-property bindings are specific to this storage
  // projection. Titles, column labels and enum labels come from the API schema.
  function boundColumns(schema, bindings) {
    return bindings
      .filter(([field]) => schema.properties[field])
      .map(([field, boundProperty, values]) => {
        const fieldSchema = schema.properties[field];
        const labels = Object.fromEntries(
          (fieldSchema.oneOf ?? [])
            .filter(
              option =>
                option.enum?.length === 1 && typeof option.title === 'string',
            )
            .map(option => [
              values?.[option.enum[0]] ?? String(option.enum[0]),
              option.title,
            ]),
        );

        return {
          property: boundProperty,
          label: fieldSchema.title ?? field.replaceAll('_', ' '),
          ...(Object.keys(labels).length
            ? { format: 'enum', labels }
            : fieldSchema.type === 'integer' && fieldSchema.minimum === 0
              ? { format: 'count' }
              : {}),
        };
      });
  }

  function repositoryColumns(collection) {
    const schema = collectionSchema(collection);
    const bindings = [
      ['name', core.name],
      ['private', property('syncable-repository-private')],
      ['open_issues_count', property('syncable-repository-open-issues')],
      ['has_issues', property('syncable-repository-has-issues')],
    ];

    return boundColumns(schema, bindings);
  }

  async function ownerView(table, collection, childCollection) {
    const schema = collectionSchema(collection);
    const childSchema = collectionSchema(childCollection);
    await collectionView(
      table,
      'syncable-owner',
      schema.title ??
        table.get(core.name) ??
        collection.name ??
        collection.resource,
      [
        ...boundColumns(schema, [
          ['login', core.name],
          [
            'type',
            property('syncable-owner-kind'),
            { Organization: 'organization', User: 'personal' },
          ],
        ]),
        {
          property: property('syncable-repository-count'),
          label:
            childSchema.title ??
            childCollection.name ??
            childCollection.resource,
          format: 'count',
        },
      ],
    );
  }

  async function openTarget(row, target) {
    // A moved resource keeps its identity; it is no longer this row's child.
    if (
      target.get(core.parent) === row.subject &&
      (await withinRoot(target.subject))
    )
      await patch(row, { [property('syncable-open-target')]: target.subject });
  }

  function repoMetadata(repo) {
    return {
      ...(typeof repo.private === 'boolean'
        ? { [property('syncable-repository-private')]: repo.private }
        : {}),
      ...(typeof repo.has_issues === 'boolean'
        ? { [property('syncable-repository-has-issues')]: repo.has_issues }
        : {}),
      ...(nonnegative(repo.open_issues_count)
        ? {
            [property('syncable-repository-open-issues')]:
              repo.open_issues_count,
          }
        : {}),
    };
  }

  function repository(repo) {
    if (
      !validId(repo?.id) ||
      !validRepo(repo?.name) ||
      !validId(repo?.owner?.id) ||
      !validLogin(repo?.owner?.login)
    )
      throw new Error('GitHub returned an invalid repository');

    return repo;
  }

  async function ensureRepository(repo, parent, connectionId) {
    repository(repo);
    const config = {
      connectionId,
      ownerId: String(repo.owner.id),
      ownerLogin: repo.owner.login,
      repoId: String(repo.id),
      repoName: repo.name,
    };

    return ensureNode({
      kind: 'repository',
      remoteId: 'github-repo:' + repo.id,
      name: repo.name,
      parent,
      config,
      metadata: repoMetadata(repo),
    });
  }

  async function refreshOrganizations(
    table = root,
    connectionId = context.connectionId,
  ) {
    const repositories = await readCollection(
      'githubRepositories',
      connectionId,
    );
    const repos = new Map(
      repositories.items.map(record => [String(repository(record).id), record]),
    );
    const found = new Map(
      [...repos.values()].map(repo => [
        String(repo.owner.id),
        {
          ...repo.owner,
          type:
            repo.owner.type === 'Organization' ? 'organization' : 'personal',
        },
      ]),
    );
    const { body: profile } = await request('user', { connectionId });
    if (!validId(profile?.id) || !validLogin(profile?.login))
      throw new Error('GitHub returned an invalid account');
    found.set(String(profile.id), {
      id: profile.id,
      login: profile.login,
      type: 'personal',
    });
    const organizations = await readCollection(
      'githubOrganizations',
      connectionId,
      true,
    );
    await ownerView(
      await store.getResource(table),
      organizations.collection,
      repositories.collection,
    );
    const columns = repositoryColumns(repositories.collection);

    for (const owner of organizations.items) {
      if (!validId(owner?.id) || !validLogin(owner?.login))
        throw new Error('GitHub returned an invalid organization');
      found.set(String(owner.id), { ...owner, type: 'organization' });
    }

    for (const owner of found.values()) {
      const selected = [...repos.values()].filter(
        repo => String(repo.owner.id) === String(owner.id),
      );
      const config = {
        connectionId,
        ownerId: String(owner.id),
        ownerLogin: owner.login,
      };
      const row = await ensureNode({
        kind: 'owner',
        parent: table,
        remoteId: 'github-owner:' + owner.id,
        name: owner.login,
        ownerKind: owner.type,
        config,
        metadata: repositories.complete
          ? { [property('syncable-repository-count')]: selected.length }
          : {},
      });
      if (!(await withinRoot(row.subject))) continue;
      const listing = await ensureNode({
        kind: 'repositories',
        parent: row.subject,
        remoteId: 'github-owner:' + owner.id,
        name: 'Repositories',
        config,
      });
      if (!(await withinRoot(listing.subject))) continue;
      await collectionView(
        listing,
        'syncable-repository',
        collectionSchema(repositories.collection).title ??
          listing.get(core.name),
        columns,
      );
      await openTarget(row, listing);
      for (const repo of selected)
        await ensureRepository(repo, listing.subject, connectionId);
    }

    return { rows: found.size, ...readState(repositories, organizations) };
  }

  async function refreshRepositories() {
    const snapshot = await readCollection('githubRepositories');
    await collectionView(
      await store.getResource(root),
      'syncable-repository',
      collectionSchema(snapshot.collection).title ??
        (await store.getResource(root)).get(core.name),
      repositoryColumns(snapshot.collection),
    );
    const repos = new Map(
      snapshot.items
        .filter(repo => String(repository(repo).owner.id) === context.ownerId)
        .map(repo => [String(repo.id), repo]),
    );
    for (const repo of repos.values())
      await ensureRepository(repo, root, context.connectionId);

    return { rows: repos.size, ...readState(snapshot) };
  }

  async function openSync(row) {
    if (await withinRoot(row.subject)) await ensureViews(row);
    const definitions = await store.getMany(row.get(tableViews) ?? []);
    const sync = definitions.find(
      definition =>
        !definition.error && definition.get(viewKind) === 'syncables',
    );
    await store.ui.openResource(sync?.subject ?? row.subject);
  }

  async function openAccount(connectionId) {
    const { body: profile } = await request('user', { connectionId });
    if (!validId(profile?.id) || !validLogin(profile?.login))
      throw new Error('GitHub returned an invalid account');
    const account = await ensureNode({
      kind: 'account',
      parent: root,
      remoteId: connectionId,
      name: profile.login,
      config: { connectionId, ownerLogin: profile.login },
    });
    const listing = await ensureNode({
      kind: 'organizations',
      parent: account.subject,
      remoteId: connectionId,
      name: 'Organizations',
      config: { connectionId },
    });
    await openTarget(account, listing);
    await openSync(listing);

    return listing;
  }

  async function openPublic() {
    const row = await ensureNode({
      kind: 'public',
      parent: root,
      remoteId: 'github-public',
      name: 'Public',
    });
    await openSync(row);

    return row;
  }

  async function ensureMirror(row) {
    if (!row.hasClasses(klass('syncable-repository')))
      throw new Error('Choose a repository from this table');
    const config = row.get(property('syncable-source-config'));
    if (
      !config ||
      !validId(config.repoId) ||
      !validId(config.ownerId) ||
      !validRepo(config.repoName) ||
      !validLogin(config.ownerLogin)
    )
      throw new Error('Invalid repository source');
    if (
      row.get(core.parent) !== root ||
      config.connectionId !== context.connectionId ||
      config.ownerId !== context.ownerId
    )
      throw new Error('Choose a repository from this table');
    if (row.get(property('syncable-repository-has-issues')) === false)
      throw new Error('Issues are disabled in GitHub');
    const mirror = await ensureNode({
      kind: 'mirror',
      parent: row.subject,
      remoteId: 'github-repo:' + config.repoId,
      name: 'Issues',
      collection: 'issues',
      config,
    });
    await openTarget(row, mirror);
    await openSync(mirror);

    return mirror;
  }

  async function linkPublic(reference) {
    const match = /^([^/]+)\/([^/]+)$/.exec(reference.trim());
    if (!match || !validLogin(match[1]) || !validRepo(match[2]))
      throw new Error('Enter a GitHub repository as owner/repo');
    const { body: repo } = await request('repos/' + match[1] + '/' + match[2], {
      connectionId: undefined,
    });
    repository(repo);
    if (
      repo.private !== false ||
      repo.has_issues !== true ||
      repo.full_name !== repo.owner.login + '/' + repo.name ||
      repo.owner.login.toLowerCase() !== match[1].toLowerCase() ||
      repo.name.toLowerCase() !== match[2].toLowerCase()
    )
      throw new Error('Choose a public GitHub repository with Issues enabled');
    const config = {
      ownerId: String(repo.owner.id),
      ownerLogin: repo.owner.login,
      repoId: String(repo.id),
      repoName: repo.name,
    };
    const owner = await ensureNode({
      kind: 'public-owner',
      parent: root,
      remoteId: 'github-public-owner:' + repo.owner.id,
      name: repo.owner.login,
      ownerKind:
        repo.owner.type === 'Organization' ? 'organization' : 'personal',
      config: { ownerId: config.ownerId, ownerLogin: config.ownerLogin },
    });
    const row = await ensureNode({
      kind: 'public-repository',
      parent: owner.subject,
      remoteId: 'github-public-repo:' + repo.id,
      name: repo.name,
      config,
      metadata: repoMetadata(repo),
    });
    const mirror = await ensureNode({
      kind: 'public-mirror',
      parent: row.subject,
      remoteId: 'github-public-repo:' + repo.id,
      name: 'Issues',
      collection: 'issues',
      config,
    });
    if (context.document)
      await ownerView(
        await store.getResource(root),
        { resource: 'githubOrganization' },
        { resource: 'githubRepository' },
      );
    await openTarget(row, mirror);
    const children = await resources({
      property: core.parent,
      value: owner.subject,
    });
    await patch(owner, {
      [property('syncable-repository-count')]: children.filter(child =>
        child.hasClasses(klass('syncable-repository')),
      ).length,
    });
    await openSync(mirror);

    return mirror;
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

  async function syncIssues() {
    if (!validId(context.repoId))
      throw new Error('Invalid GitHub repository source');
    const existing = new Map(
      (await resources({ property: core.parent, value: root })).map(row => [
        row.get(core.localId),
        row,
      ]),
    );
    const seen = new Set();
    const counts = { added: 0, changed: 0, unchanged: 0 };
    const snapshot = await readCollection('repositoryIssues');
    const issues = snapshot.items
      .filter(item => !item?.pull_request)
      .map(issue => {
        if (
          !Number.isSafeInteger(issue?.id) ||
          issue.id <= 0 ||
          !Number.isSafeInteger(issue.number) ||
          issue.number <= 0 ||
          typeof issue.title !== 'string' ||
          !issue.title ||
          issue.title.length > 4096 ||
          !['open', 'closed'].includes(issue.state) ||
          typeof issue.updated_at !== 'string' ||
          issue.updated_at.length > 64 ||
          !Number.isFinite(Date.parse(issue.updated_at)) ||
          !/^https:\/\/github\.com\/[a-z0-9._-]+\/[a-z0-9._-]+\/issues\/[0-9]+$/i.test(
            issue.html_url,
          ) ||
          (issue.body !== null &&
            issue.body !== undefined &&
            (typeof issue.body !== 'string' || issue.body.length > 200000))
        )
          throw new Error('GitHub returned an invalid issue');

        return {
          id: String(issue.id),
          values: {
            [core.name]: issue.title,
            [core.localId]: 'syncables:github-issue:' + issue.id,
            [property('syncable-issue-number')]: issue.number,
            [property('syncable-issue-state')]: issue.state,
            [property('syncable-issue-updated')]: Date.parse(issue.updated_at),
            [property('syncable-issue-link')]: issue.html_url,
            [property('syncable-issue-body')]: issue.body ?? '',
          },
        };
      });

    for (const issue of issues) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      const old = existing.get(issue.values[core.localId]);
      if (old && !old.hasClasses(klass('syncable-record')))
        throw new Error('Issue identity is already in use');

      if (old)
        counts[(await patch(old, issue.values)) ? 'changed' : 'unchanged']++;
      else {
        const row = await store.newResource({
          parent: root,
          isA: [klass('syncable-record')],
          propVals: issue.values,
        });
        existing.set(issue.values[core.localId], row);
        counts.added++;
      }
    }

    return { ...counts, rows: seen.size, ...readState(snapshot) };
  }

  async function refresh() {
    if ((await status()).paused) throw new Error('Resume before syncing');

    try {
      const result =
        context.kind === 'organizations'
          ? await refreshOrganizations()
          : context.kind === 'repositories'
            ? await refreshRepositories()
            : context.kind === 'mirror'
              ? await syncIssues()
              : (() => {
                  throw new Error('Select a collection to sync');
                })();
      await saveStatus({
        ...result,
        ...(result.incomplete ? {} : { lastSuccess: new Date().toISOString() }),
        error: result.incomplete
          ? (result.error ?? 'Read limit reached. Local rows were retained.')
          : null,
      });

      return result;
    } catch (error) {
      await saveStatus({
        error: String(error?.message ?? error).slice(0, 1024),
      }).catch(() => undefined);
      throw error;
    }
  }

  async function storedRepositories() {
    return (await resources({ property: core.parent, value: root })).filter(
      row => row.hasClasses(klass('syncable-repository')),
    );
  }

  return {
    refresh,
    refreshOrganizations,
    refreshRepositories,
    syncIssues,
    openAccount,
    openPublic,
    ensureMirror,
    linkPublic,
    status,
    saveStatus,
    storedRepositories,
    ensureNode,
  };
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;

  return node;
}

/** Opening this screen reads saved Atomic state. Only explicit actions refresh GitHub. */
export async function view({ root, store }) {
  const context = await store.getContext();
  const app = createSyncApp(store, context);

  if (context.worker) {
    await store.execution('state');
    await app.refresh();

    return;
  }

  if (context.selection) {
    await app.ensureMirror(await store.getResource(context.selection));

    return;
  }

  const styles = document.createElement('style');
  styles.textContent =
    ':root{font-family:"Open Sans","Segoe UI",sans-serif;color-scheme:light dark}body{margin:0;font-size:14px}#root{padding:12px 0}.toolbar,.controls{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:16px}.controls{justify-content:flex-start}button,input,select{font:inherit;padding:7px 12px;border:1px solid #aaa;border-radius:8px;color:inherit;background:transparent}button{cursor:pointer}button:disabled{opacity:.55}.muted{color:#777}.error{padding:12px;border:1px solid #c66;border-radius:8px}.metric-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.metric{padding:14px;border:1px solid #ddd;border-radius:9px}.metric strong{display:block;font-size:18px}@media(max-width:600px){.metric-row{grid-template-columns:1fr}}';
  document.head.append(styles);

  const error = reason => {
    root.querySelector('[role=alert]')?.remove();
    const message = el('p', String(reason?.message ?? reason), 'error');
    message.setAttribute('role', 'alert');
    root.prepend(message);
  };

  const button = (label, action) => {
    const node = el('button', label);
    node.addEventListener('click', async () => {
      node.disabled = true;

      try {
        await action();
      } catch (reason) {
        error(reason);
      } finally {
        node.disabled = false;
      }
    });

    return node;
  };

  const heading = (title, subtitle) => {
    root.replaceChildren();
    const bar = el('div', undefined, 'toolbar');
    const titleBox = el('div');
    titleBox.append(el('strong', title));
    if (subtitle) titleBox.append(el('p', subtitle, 'muted'));
    bar.append(titleBox);
    root.append(bar);

    return bar;
  };

  const reconnect = () =>
    button('Reconnect', () =>
      store.proxy.connect({ platform: 'github-issues' }),
    );

  const openCustom = async () => {
    const table = await store.getResource(context.subject);
    const definitions = await store.getMany(table.get(tableViews) ?? []);
    const target = definitions.find(
      row =>
        !row.error &&
        [
          'syncable-collection',
          'github-organizations',
          'github-repositories',
        ].includes(row.get(viewKind)),
    );

    if (target) await store.ui.openResource(target.subject);
    else {
      const normal = definitions.find(
        row => !row.error && row.get(viewKind) === 'table',
      );
      await store.ui.openResource(normal?.subject ?? context.subject);
    }
  };

  if (context.kind === 'platform') {
    const controls = el('div', undefined, 'controls');
    heading(
      'Connected GitHub accounts',
      'Connect an account, then refresh its collections from Sync.',
    );
    controls.append(
      button('Connect account', () =>
        store.proxy.connect({ platform: 'github-issues' }),
      ),
      button('Public repositories', () => app.openPublic()),
    );
    root.append(controls);
    const connected = await store.proxy.connections({
      platform: 'github-issues',
    });

    if (!connected.length) {
      root.append(
        el('h3', 'No accounts connected'),
        button('Connect GitHub account', () =>
          store.proxy.connect({ platform: 'github-issues' }),
        ),
      );
    } else
      for (const connection of connected) {
        const card = el('div', undefined, 'metric');
        card.append(
          el('strong', connection.login ?? 'GitHub account'),
          button('Browse organizations', () =>
            app.openAccount(connection.connectionId),
          ),
        );
        root.append(card);
      }

    return;
  }

  if (context.kind === 'public') {
    heading('Public repositories', 'Link a public repository by name.');
    const label = el('label', 'Public GitHub repository');
    const input = el('input');
    input.id = 'public-github-repository';
    input.placeholder = 'owner/repo';
    label.htmlFor = input.id;
    const link = button('Link repository', () => app.linkPublic(input.value));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        link.click();
      }
    });
    const controls = el('div', undefined, 'controls');
    controls.append(input, link, button('Browse owners', openCustom));
    root.append(label, controls);

    return;
  }

  let timer;

  const render = async () => {
    clearTimeout(timer);
    const state = await store.execution('state');
    const status = await app.status();
    const controls = el('div', undefined, 'controls');
    heading(
      context.kind === 'mirror'
        ? 'Issues sync'
        : context.kind === 'organizations'
          ? 'Organizations sync'
          : 'Repositories sync',
      context.kind === 'mirror'
        ? context.ownerLogin + '/' + context.repoName
        : 'Refresh GitHub here; browse stored data in the other views.',
    );

    if (!status.paused) {
      const start = button(
        state.running
          ? 'Syncing'
          : context.kind === 'mirror'
            ? 'Sync now'
            : 'Refresh list',
        async () => {
          await store.execution('start');
          await render();
        },
      );
      start.disabled = state.running;
      controls.append(start);
    }

    controls.append(
      button(status.paused ? 'Resume' : 'Pause', async () => {
        if (!status.paused) await store.execution('cancel');
        await app.saveStatus({ paused: !status.paused });
        await render();
      }),
    );
    if (context.connectionId) controls.append(reconnect());
    root.append(controls);
    const grid = el('div', undefined, 'metric-row');

    for (const [value, label] of [
      [
        status.rows ?? 0,
        context.kind === 'mirror' ? 'Imported issues' : 'Stored entries',
      ],
      [
        status.paused
          ? 'Paused'
          : state.running
            ? 'Syncing'
            : status.error
              ? 'Needs attention'
              : 'Ready',
        'Synchronization',
      ],
      [status.lastSuccess ?? 'Never', 'Last successful sync'],
    ]) {
      const metric = el('div', undefined, 'metric');
      metric.append(el('strong', value), el('small', label));
      grid.append(metric);
    }

    root.append(grid);
    if (status.lastSuccess || status.incomplete)
      root.append(
        el(
          'p',
          `${status.added ?? 0} added · ${status.changed ?? 0} changed · ${status.unchanged ?? 0} unchanged`,
          'muted',
        ),
      );
    if (status.error) error(status.error);
    if (context.kind === 'mirror')
      root.append(
        el(
          'p',
          'Source: GitHub · ' +
            context.ownerLogin +
            '/' +
            context.repoName +
            (context.mode === 'public'
              ? ' · public repository.'
              : ' · read-only via integration proxy.'),
          'muted',
        ),
      );
    else root.append(button('Browse stored data', openCustom));

    if (context.kind === 'repositories' && !state.running) {
      const rows = await app.storedRepositories();

      if (rows.length) {
        const select = el('select');
        select.setAttribute('aria-label', 'Repository');

        for (const row of rows) {
          const option = el('option', row.get(core.name));
          option.value = row.subject;
          select.append(option);
        }

        const repositoryControls = el('div', undefined, 'controls');
        repositoryControls.append(
          select,
          button('Sync issues', async () =>
            app.ensureMirror(await store.getResource(select.value)),
          ),
        );
        root.append(repositoryControls);
      }
    }

    if (state.running)
      timer = setTimeout(() => {
        void render().catch(error);
      }, 500);
  };

  await render();
}
