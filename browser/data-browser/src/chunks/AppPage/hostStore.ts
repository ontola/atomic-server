import { canViewAccess } from '@helpers/extensions/viewPolicy';
import type { Store } from '@tomic/react';
import { isPlatformId, type ProxyHost } from '@helpers/proxyConnections';
import { fetchRowGrant } from './rowGrant';
import {
  connectionsOf,
  forgetInstallationConnection,
} from '@helpers/installationConnections';
import {
  fetchRouteStatus,
  revokeRouteTokenBody,
  routeTokensBody,
} from '@chunks/Plugins/routeStatusApi';
import {
  acceptFor,
  CollectionBuilder,
  core,
  destinationOwnerOf,
  destinationTablesFor,
  errorMessageFromResponse,
  server,
  findSchema,
  isAtomicIdentifier,
  isResourceSubject,
  pluginConfigFor,
  pluginConfigProblems,
  pluginSchema,
  signRequest,
  type ApplyReport,
  type JSONObject,
  type PluginManifest,
  type RunPlan,
} from '@tomic/react';
import type { ImporterRunResult } from '@tomic/plugin';
import {
  checkSize,
  sameEncoding,
  type ImportUpload,
} from '@chunks/PluginRuns/importFile';

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
 *
 * One such grant exists (#1740): an app shown as a table's view may edit that
 * table's rows once someone who can edit the table allowed it. Those writes
 * go to the server like any other; the server holds the grant and decides.
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
  /** `save`: properties the view removed, sent apart from `propVals`. */
  remove?: string[];
  // `proxyCapability` / `proxyConnections`
  platform?: string;
  connectionId?: string;
  /** The frame's own Ed25519 public key, base64url. */
  publicKey?: string;
  /** `openExternal`: the http(s) link to open once the person confirms. */
  url?: string;
  /** `getMany`: the subjects to read, in order. Checked, since the frame sends it. */
  subjects?: unknown;
  path?: string;
  method?: string;
  query?: Record<string, string>;
  body?: string;
  ifMatch?: string;
  // `revokeRouteToken`
  tokenId?: string;
  // `runImporter`
  file?: unknown;
  importer?: string;
}

/**
 * How many subjects one `getMany` may ask for. Enough for a page of rows in
 * one round trip, and a bound on what a frame can make this page load at once.
 */
export const MAX_GET_MANY = 100;

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

    case 'get':
      return readForApp(store, required(request.subject, 'subject'));

    // Many `get`s in one round trip: each subject is read exactly as `get`
    // reads it, through this person's store, so it sees what they see and
    // their own writes. One that cannot be read is reported in its place
    // rather than failing the rest.
    case 'getMany': {
      const subjects = request.subjects;

      if (
        !Array.isArray(subjects) ||
        !subjects.every(s => typeof s === 'string' && s !== '')
      )
        throw new Error('getMany takes an array of subjects');

      if (subjects.length > MAX_GET_MANY)
        throw new Error(
          `getMany reads at most ${MAX_GET_MANY} subjects at a time; ask in batches`,
        );

      return Promise.all(
        (subjects as string[]).map(async subject => {
          try {
            const { propVals, ...rest } = await readForApp(store, subject);

            return { ...rest, props: propVals, loading: false };
          } catch (e) {
            return { subject, error: (e as Error).message };
          }
        }),
      );
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

      await refuseOutsideApp(store, parent, app, table, 'create');

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

      await refuseOutsideApp(store, subject, app, table, 'save');

      // `save` on the server only sets, so a property the view removed goes
      // as its own write. Without this, `resource.remove(p).save()` left `p`
      // in place while the view believed it gone. Removed first: if the
      // save then fails, a retry sees the property already gone rather than
      // a value the view thinks it no longer owns.
      const removed = (request.remove ?? []).filter(
        (p): p is string => typeof p === 'string' && p !== '',
      );

      if (removed.length) {
        await writeAsApp(store, drive, app, {
          op: 'remove',
          subject,
          properties: removed,
        });
      }

      await writeAsApp(store, drive, app, {
        op: 'save',
        subject,
        propVals: request.propVals ?? {},
      });
      await refresh(store, subject);

      return { subject };
    }

    case 'destroy': {
      const subject = required(request.subject, 'subject');

      await refuseOutsideApp(store, subject, app, table, 'destroy');
      await writeAsApp(store, drive, app, { op: 'destroy', subject });

      return { subject };
    }

    // Whether this app may edit the rows of the table it is a view of
    // (#1740). Not a secret: the app needs it to decide whether to show an
    // editable field or an ask.
    case 'rowAccess':
      return rowAccess(store, drive, app, table);

    // Needs the person: a confirmation, drawn by the caller. A host that
    // cannot show one refuses rather than granting unseen.
    case 'requestRowAccess':
      throw new Error('This host cannot ask to let an app edit rows here.');

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

    // Only this app's own access goes: its delegation at the proxy, and on
    // an Installation the recorded `integrationConnections[platform]`, as the
    // Installation page's Disconnect does. The connection itself stays;
    // other apps may use it, and deleting it is a page action.
    case 'proxyDisconnect': {
      if (!proxy)
        throw new Error('This host cannot reach the integration proxy.');
      const platform = required(request.platform, 'platform');
      if (!isPlatformId(platform)) throw new Error('Invalid platform');

      const recorded = connectionsOf(
        (await store.getResource(app)).get(
          server.properties.integrationConnections,
        ),
      )[platform];
      const connectionIds = await proxy.disconnect(
        platform,
        recorded ? [recorded] : [],
      );

      if (recorded) await forgetInstallationConnection(store, app, platform);

      return { status: 'disconnected', platform, connectionIds };
    }

    // The bearer tokens this app's routes issued (plugin routes, #1718):
    // listed and revoked, never read. The server holds only their hashes.
    case 'routeTokens':
      return await routeTokensBody(store, app);

    case 'revokeRouteToken':
      return await revokeRouteTokenBody(
        store,
        app,
        required(request.tokenId, 'tokenId'),
      );

    // The app's endpoint health (#1721): per route its URL, 24-hour counts
    // and last error, and the delivery queue. Only for someone who may
    // write the Installation, as on its page; `null` on a server built
    // without plugin routes.
    case 'readRouteStatus':
      await requireWrite(store, app);

      return (await fetchRouteStatus(store, app)) ?? null;

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

/** One resource, as this person's store has it. What `get` answers. */
async function readForApp(store: Store, subject: string) {
  const resource = await store.getResource(subject);

  if (resource.error) throw resource.error;

  return {
    subject: resource.subject,
    title: resource.title,
    propVals: resource.getPropVals(),
  };
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
 * Pulls the server's copy of a resource the app just wrote into this page's
 * store.
 *
 * The write went through `/app-write`, not through this store, so the copy
 * cached here is the one from before it. The next `get` from the view read
 * that stale copy: an app that compares what it imports with what is stored
 * saw its own last write as missing and wrote it again. Best effort: the
 * write already succeeded, so a failed refresh is not the view's error.
 */
async function refresh(store: Store, subject: string): Promise<void> {
  // Replace rather than merge: a merge keeps properties the write removed.
  // `applyIncoming` still refuses to clobber unsaved local edits.
  await store
    .fetchResourceFromServer?.(subject, { forceOverride: true })
    .catch(() => undefined);
}

/** The signed-in person may write `subject`, or this throws. */
async function requireWrite(store: Store, subject: string): Promise<void> {
  const agent = store.getAgent();

  if (!agent) throw new Error('Sign in to manage this app');

  const resource = await store.getResource(subject);
  const [canWrite] = await resource.canWrite(agent.subject);

  if (!canWrite) throw new Error('Only people who can edit this app see this');
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
  table: string | undefined,
  op: 'create' | 'save' | 'destroy',
): Promise<void> {
  if (await isWithinApp(store, subject, app)) return;

  // A row of the table this app is a view of: the server decides, from the
  // grant someone gave it there. For `create` the subject is the parent.
  if (table) {
    const parent =
      op === 'create'
        ? subject
        : ((await store.getResource(subject)).get(core.properties.parent) as
            | string
            | undefined);

    if (parent === table) {
      if (op === 'destroy') throw new Error(ROW_DESTROY_REFUSED);

      return;
    }
  }

  throw new Error(
    'This app may only write its own data. Writing here needs rights its key does not have.',
  );
}

/** Longer subjects are not something a person could be sent to. */
const MAX_SUBJECT = 2048;

/**
 * The subject `openResource` may send the host page to, or an error the app
 * can show.
 *
 * Only a resource: an Atomic resource identifier (not an agent, commit, blob
 * or node) or an http(s) resource URL. And only one the signed-in person can
 * already read, checked by loading it through their store, so an app cannot
 * use the host to show them anything they could not open themselves.
 */
export async function resourceToOpen(
  store: Store,
  subject: unknown,
): Promise<string> {
  if (
    typeof subject !== 'string' ||
    subject.length === 0 ||
    subject.length > MAX_SUBJECT ||
    !(isAtomicIdentifier(subject)
      ? isResourceSubject(subject)
      : isHttpUrl(subject))
  )
    throw new Error('openResource takes a resource subject');

  const resource = await store.getResource(subject);

  if (resource.error)
    throw new Error(
      `openResource cannot open ${subject}: ${resource.error.message}`,
    );

  return subject;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !!url.host
    );
  } catch {
    return false;
  }
}

export const ROW_DESTROY_REFUSED =
  'Letting an app edit rows does not let it delete them.';

/** What `store.rowAccess()` answers. */
export type RowAccess =
  | {
      status: 'granted';
      grantedBy: string;
      grantedAt: number;
      via: string;
    }
  | { status: 'none' }
  /** Not shown as a table's view, so there are no rows to be given. */
  | { status: 'unavailable' };

export async function rowAccess(
  store: Store,
  drive: string,
  app: string,
  table: string | undefined,
): Promise<RowAccess> {
  if (!table) return { status: 'unavailable' };

  const { grant } = await fetchRowGrant(store, { drive, table, app });

  return grant
    ? {
        status: 'granted',
        grantedBy: grant.grantedBy,
        grantedAt: grant.grantedAt,
        via: grant.via,
      }
    : { status: 'none' };
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

const FILE_SHAPE =
  'file must be { name, mediaType?, text } or { name, mediaType?, base64 }';
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * A file the app handed over: well-formed, in the encoding the `accepts`
 * entry it falls under declares (`text`, or `base64` for `as: 'base64'`),
 * and no larger than the entries sharing that encoding accept.
 */
function appFile(file: unknown, manifest: PluginManifest): ImportUpload {
  const f = file as
    | (Partial<Record<'name' | 'mediaType' | 'text' | 'base64', unknown>> &
        object)
    | null;

  if (
    !f ||
    typeof f !== 'object' ||
    typeof f.name !== 'string' ||
    !f.name ||
    (f.mediaType !== undefined && typeof f.mediaType !== 'string') ||
    (typeof f.text === 'string') === (typeof f.base64 === 'string') ||
    (f.text !== undefined && typeof f.text !== 'string') ||
    (f.base64 !== undefined && typeof f.base64 !== 'string')
  )
    throw new Error(FILE_SHAPE);

  const name = f.name;
  const mediaType = (f.mediaType as string | undefined) ?? '';
  const accepts = manifest.accepts ?? [];
  const accept = acceptFor({ name, type: mediaType }, accepts);
  if (!accept) throw new Error("This app's importer does not take files.");
  const wants = accept.as ?? 'text';

  if (typeof f.base64 === 'string') {
    if (wants !== 'base64')
      throw new Error(
        `This importer reads ${name} as text; pass file.text, not file.base64.`,
      );
    if (!BASE64.test(f.base64))
      throw new Error('file.base64 must be standard, padded base64.');
    const padding = f.base64.endsWith('==')
      ? 2
      : f.base64.endsWith('=')
        ? 1
        : 0;
    const size = (f.base64.length / 4) * 3 - padding;
    checkSize(size, sameEncoding(accept, accepts));

    return { name, mediaType, size, base64: f.base64 };
  }

  if (wants !== 'text')
    throw new Error(
      `This importer reads ${name} as base64; pass file.base64, not file.text.`,
    );
  const text = f.text as string;
  const size = new TextEncoder().encode(text).length;
  checkSize(size, sameEncoding(accept, accepts));

  return { name, mediaType, size, text };
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
