import { canViewAccess } from '@helpers/extensions/viewPolicy';
import type { Store } from '@tomic/react';
import type { ProxyHost } from '@helpers/proxyConnections';
import {
  CollectionBuilder,
  core,
  destinationOwnerOf,
  destinationTablesFor,
  errorMessageFromResponse,
  findSchema,
  pluginConfigFor,
  pluginConfigProblems,
  pluginSchema,
  signRequest,
  type ApplyReport,
  type JSONObject,
  type PluginManifest,
  type RunPlan,
} from '@tomic/react';
import type { ImporterFile, ImporterRunResult } from '@tomic/plugin';
import { checkSize, type ImportUpload } from '@chunks/PluginRuns/importFile';

/**
 * Answers the data requests an app's view makes.
 *
 * The view runs in a null-origin frame and has no rights of its own, so every
 * read goes through this page's store — which means it sees exactly what the
 * signed-in person sees, no more.
 *
 * Writes are confined to the app's own subtree. "May this app write its own
 * data" needs no permission dialog; "may this app write your calendar" does,
 * and that is a grant (B4) rather than something to wave through here in the
 * meantime.
 */

export interface HostRequest {
  __atomic: true;
  id: number | string;
  op: string;
  subject?: string;
  property?: string;
  value?: string;
  parent?: string;
  isA?: string[];
  propVals?: Record<string, unknown>;
  // `proxyCapability` / `proxyConnections`
  platform?: string;
  connectionId?: string;
  /** The frame's own Ed25519 public key, base64url. */
  publicKey?: string;
  // `runImporter`
  file?: unknown;
  importer?: string;
}

export interface HostReply {
  id: number | string;
  result?: unknown;
  error?: string;
}

export function isHostRequest(data: unknown): data is HostRequest {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as HostRequest).__atomic === true &&
    (typeof (data as HostRequest).id === 'number' ||
      typeof (data as HostRequest).id === 'string')
  );
}

/**
 * Whether `subject` is the app or something under it.
 *
 * Bounded rather than exhaustive: a cycle in a parent chain would otherwise
 * hang the frame's request, and twelve levels is far deeper than any app's own
 * data goes.
 */
export async function isWithinApp(
  store: Store,
  subject: string,
  app: string,
): Promise<boolean> {
  return canViewAccess(store, subject, { kind: 'app', root: app }, 'write');
}

export async function handleRequest(
  store: Store,
  app: string,
  drive: string,
  request: HostRequest,
  /** The table this app is a view of, when it is being used as one. */
  table?: string,
  /**
   * This app's integration-proxy access, as the signed-in user grants it.
   * Absent where the host cannot (no signed-in agent, or a host without it).
   */
  proxy?: ProxyHost,
): Promise<unknown> {
  switch (request.op) {
    case 'app':
      return app;

    case 'data': {
      // The table it was pointed at, if any, and its own otherwise. So one
      // app can be its own thing on its own page and a view of someone
      // else's rows on a table tab, without knowing which it is.
      const resource = await store.getResource(app);
      const schema = await findSchema(store, drive, pluginSchema());
      const own = schema.properties?.['app-data']
        ? (resource.get(schema.properties['app-data']) as string | undefined)
        : undefined;
      const subject = table ?? own;

      if (!subject) return undefined;

      // The row class comes off the table rather than the app: a table already
      // names what its rows are, and duplicating that on the app would be two
      // places to disagree.
      const tableResource = await store.getResource(subject);
      // A table an importer's Set up created together with others (a
      // manifest `destination.tables`): its siblings, by the keys the
      // manifest declared, so a view of transactions can find statements.
      const tables = await destinationTablesFor(store, drive, subject);

      return {
        table: subject,
        rowClass: tableResource.get(core.properties.classtype) as
          | string
          | undefined,
        ...(tables ? { tables } : {}),
      };
    }

    case 'get': {
      const resource = await store.getResource(
        required(request.subject, 'subject'),
      );

      if (resource.error) throw resource.error;

      return {
        subject: resource.subject,
        title: resource.title,
        propVals: resource.getPropVals(),
      };
    }

    case 'query': {
      // A collection, not `search`. Search drops `filters` whenever it falls
      // back to the local index — property-value constraints need the
      // server's — so an app asking for its own children quietly received the
      // whole drive. Wrong, and a far bigger answer than it asked for.
      const collection = new CollectionBuilder(store)
        .setProperty(required(request.property, 'property'))
        .setValue(required(request.value, 'value'))
        .setPageSize(500)
        .build();

      return await collection.getAllMembers();
    }

    case 'create': {
      // Defaulting the parent to the app is not a convenience: it is the one
      // place a view may always write, so it is the only sensible default.
      const parent = request.parent ?? app;

      await refuseOutsideApp(store, parent, app);

      const { subject } = await writeAsApp(store, drive, app, {
        op: 'create',
        parent,
        isA: request.isA ?? [],
        propVals: request.propVals ?? {},
      });

      const created = await store.getResource(subject);

      return { subject, title: created.title, propVals: created.getPropVals() };
    }

    case 'save': {
      const subject = required(request.subject, 'subject');

      await refuseOutsideApp(store, subject, app);
      await writeAsApp(store, drive, app, {
        op: 'save',
        subject,
        propVals: request.propVals ?? {},
      });

      return { subject };
    }

    case 'destroy': {
      const subject = required(request.subject, 'subject');

      await refuseOutsideApp(store, subject, app);
      await writeAsApp(store, drive, app, { op: 'destroy', subject });

      return { subject };
    }

    // The frame names a connection and brings its own public key; the user
    // signs a capability bound to that key, for that connection only, after
    // the page has checked the connection is delegated to this app. The frame
    // then calls the proxy itself. Nothing here is a credential on its own:
    // every request must also be signed with the frame's key.
    case 'proxyCapability': {
      if (!proxy)
        throw new Error('This host cannot reach the integration proxy.');

      return await proxy.capability({
        platform: required(request.platform, 'platform'),
        connectionId: required(request.connectionId, 'connectionId'),
        publicKey: required(request.publicKey, 'publicKey'),
      });
    }

    case 'proxyConnections':
      return proxy
        ? await proxy.connections(required(request.platform, 'platform'))
        : [];

    // Needs the person: a picker and a review, drawn by the caller. A host
    // that cannot show them refuses rather than applying unseen.
    case 'runImporter':
      throw new Error('This host cannot show an import review here.');

    // Subscriptions are wired by the caller, which owns the frame it has to
    // post back to.
    case 'subscribe':
    case 'unsubscribe':
      return true;

    default:
      throw new Error(
        `This app asked for something the host does not do: ${request.op}`,
      );
  }
}

/**
 * Asks the server to perform a write as the app.
 *
 * Not done in the page, because a commit is signed by whoever's key is here —
 * the user's. A write signed by the person is authored by the person and
 * bounded by what the person may reach, which makes this file's rules the only
 * thing standing between a third-party app and the whole drive. The server
 * holds the app's key, so it can sign as the app and let the ordinary rights
 * walk decide.
 *
 * The frame is never given that key: a secret in a null-origin iframe is
 * extractable and never expires.
 */
async function writeAsApp(
  store: Store,
  drive: string,
  app: string,
  request: Record<string, unknown>,
): Promise<{ subject: string }> {
  const agent = store.getAgent();

  if (!agent) throw new Error('Sign in to use this app');

  const url = `${store.getServerUrl()}/app-write`;
  const headers = await signRequest(url, agent, {});

  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ drive, app, ...request }),
  });

  if (!response.ok) {
    throw new Error(
      errorMessageFromResponse(await response.text(), response.status),
    );
  }

  return (await response.json()) as { subject: string };
}

/**
 * The app's subtree, checked here as well as on the server.
 *
 * Not the authority: what an app may write is what its agent's DID is on, and
 * the rights walk decides that when the commit lands. This is the same answer
 * arrived at early, so a refusal reaches the app as an error it can show
 * rather than as a commit rejected after the fact.
 */
async function refuseOutsideApp(
  store: Store,
  subject: string,
  app: string,
): Promise<void> {
  if (await isWithinApp(store, subject, app)) return;

  throw new Error(
    'This app may only write its own data. Writing here needs rights its key does not have.',
  );
}

function required(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} is required`);
  }

  return value;
}

/** The importer an app may run, resolved and checked by the host. */
export interface AppImporter {
  importer: string;
  title: string;
  source: string;
  manifest: PluginManifest;
  config: JSONObject;
  /** The file the app handed over, checked; absent when the person picks one. */
  upload?: ImportUpload;
}

export const NO_IMPORTER =
  "This app has no importer to run. It can run one only while it is shown as a view of the importer's table.";
export const FOREIGN_IMPORTER =
  'This app may only run its own importer: the one that created the table it shows.';

/**
 * Which importer `store.importer.run()` may start, or why none.
 *
 * The app never chooses. The host resolves the importer from the table the
 * app is a view of: the plugin whose Set up created that table and still
 * names it in its config. An app on its own page, or on a table no importer
 * made, has none. An app naming a different importer is refused, so a view
 * cannot reach a plugin of another package through this op.
 *
 * Nothing here writes or runs anything: running happens after the person has
 * agreed, and writing only after they approved the review.
 */
export async function resolveAppImporter(
  store: Store,
  drive: string,
  table: string | undefined,
  request: Pick<HostRequest, 'file' | 'importer'>,
  describe: (source: string) => Promise<PluginManifest>,
): Promise<AppImporter> {
  if (!table) throw new Error(NO_IMPORTER);
  const importer = await destinationOwnerOf(store, drive, table);
  if (!importer) throw new Error(NO_IMPORTER);

  if (request.importer !== undefined && request.importer !== importer)
    throw new Error(FOREIGN_IMPORTER);

  const schema = await findSchema(store, drive, pluginSchema());
  const resource = await store.getResource(importer);

  const read = (name: string) => {
    const property = schema.properties?.[name];

    return property ? resource.get(property) : undefined;
  };

  const source = read('plugin-source');
  if (typeof source !== 'string' || !source) throw new Error(NO_IMPORTER);

  const manifest = await describe(source);
  if (!manifest.accepts?.length)
    throw new Error("This app's importer does not take files.");

  const config = pluginConfigFor(
    { schemas: read('plugin-schemas'), connection: read('plugin-connection') },
    manifest.config,
  );
  if (pluginConfigProblems(config, manifest.config).length > 0)
    throw new Error(
      'This importer needs Set up first. Open it and choose Set up.',
    );

  const upload =
    request.file === undefined ? undefined : appFile(request.file, manifest);

  return {
    importer,
    title: resource.title,
    source,
    manifest,
    config,
    ...(upload ? { upload } : {}),
  };
}

/** A file the app handed over: well-formed, and no larger than accepted. */
function appFile(file: unknown, manifest: PluginManifest): ImportUpload {
  const f = file as Partial<ImporterFile> | null;

  if (
    !f ||
    typeof f !== 'object' ||
    typeof f.name !== 'string' ||
    !f.name ||
    typeof f.text !== 'string' ||
    (f.mediaType !== undefined && typeof f.mediaType !== 'string')
  )
    throw new Error('file must be { name, mediaType?, text }');

  const size = new TextEncoder().encode(f.text).length;
  checkSize(size, manifest.accepts ?? []);

  return { name: f.name, mediaType: f.mediaType ?? '', size, text: f.text };
}

/**
 * What the app is told once the person is done: counts, not rows. The app
 * reads the rows themselves through its table, as it always does.
 */
export function importerRunSummary(
  importer: string,
  outcome:
    | { report: ApplyReport; plan: RunPlan }
    | { plan?: RunPlan; error?: string },
): ImporterRunResult {
  if ('report' in outcome) {
    const applied = outcome.report.outcomes.filter(o => o.status === 'applied');
    const failed = outcome.report.outcomes.filter(o => o.status === 'failed');

    return {
      status: 'applied',
      importer,
      created: applied.filter(o => o.op === 'create').length,
      // Distinct subjects: a set and a remove on one row are one update.
      updated: new Set(
        applied
          .filter(o => o.op === 'set' || o.op === 'remove')
          .map(o => o.subject),
      ).size,
      destroyed: applied.filter(o => o.op === 'destroy').length,
      failed: failed.length,
      errors: failed.map(
        o => o.error ?? /* @wc-ignore */ `Could not ${o.op} ${o.subject}`,
      ),
    };
  }

  if (outcome.error)
    return { status: 'blocked', importer, errors: [outcome.error] };

  const { plan } = outcome;

  if (plan?.blocked)
    return {
      status: 'blocked',
      importer,
      errors: [
        ...plan.problems,
        ...plan.changes.flatMap(change => change.problems),
      ]
        .filter(problem => problem.severity === 'error')
        .map(problem => problem.message),
    };

  if (plan && plan.changes.length === 0) return { status: 'nothing', importer };

  return { status: 'cancelled', importer };
}
