import {
  errorMessageFromResponse,
  signRequest,
  signedRequestInit,
  type Store,
} from '@tomic/react';
import { findSchema, pluginSchema } from '@tomic/lib';

/**
 * An app's grant to edit the rows of a table it is a view of (#1740).
 *
 * The server keeps it and enforces it on every `/app-write`
 * (`server/src/plugins/app_row_grant.rs`). Setting a View's `view-kind` to an
 * app grants nothing: a grant comes only from someone who can edit the table
 * confirming it, and the server records that person (the request's signer),
 * the time and the gesture.
 */
export interface RowGrant {
  id: string;
  drive: string;
  app: string;
  appAgent: string;
  table: string;
  view: string;
  grantedBy: string;
  /** Milliseconds since the epoch, by the server's clock. */
  grantedAt: number;
  via: RowGrantVia;
  /**
   * The app's `row-extras` when this was granted (#1849): properties besides
   * the table's columns it may write on rows, such as a sync's provider id,
   * ETag and baseline. Absent when it declared none.
   */
  extras?: string[];
  revokedAt?: number;
  revokedBy?: string;
  revokedVia?: RowRevokeVia;
}

/**
 * The gesture that gave a grant: adding the app from "+ Add view", switching
 * a tab to it in "View type", the app's own request, or the tab's menu.
 */
export type RowGrantVia = 'add-view' | 'view-type' | 'request' | 'menu';

/**
 * What ended one. `granter-lost-write` and `app-key-changed` are recorded by
 * the server itself; `superseded` when a new grant replaced it because the
 * app's `row-extras` changed.
 */
export type RowRevokeVia =
  | 'menu'
  | 'view-removed'
  | 'view-kind-changed'
  | 'granter-lost-write'
  | 'app-key-changed'
  | 'superseded';

/**
 * The properties `app` declares in `row-extras` (#1849), or none when it
 * declares none or they cannot be read. The server decides what a grant
 * covers; this is for saying so before someone agrees, and for keeping them
 * out of the row's normal fields.
 */
export async function appRowExtras(
  store: Store,
  drive: string,
  app: string,
): Promise<string[]> {
  try {
    const schema = await findSchema(store, drive, pluginSchema());
    const property = schema.properties?.['row-extras'];

    if (!property) return [];

    const value = (await store.getResource(app)).get(property);

    return Array.isArray(value)
      ? [...new Set(value.filter((v): v is string => typeof v === 'string'))]
      : [];
  } catch {
    return [];
  }
}

/** Declared extras a grant does not cover: a reason to ask again. */
export function uncoveredExtras(
  grant: Pick<RowGrant, 'extras'>,
  declared: string[],
): string[] {
  const covered = new Set(grant.extras ?? []);

  return declared.filter(extra => !covered.has(extra));
}

export interface RowGrantTarget {
  drive: string;
  table: string;
  app: string;
}

export interface RowGrantStatus {
  /** The live grant, or `null` when the app may only read this table. */
  grant: RowGrant | null;
  /** Every grant this app had on this table, oldest first. */
  history: RowGrant[];
}

function signedIn(store: Store) {
  const agent = store.getAgent();

  if (!agent) throw new Error('Sign in to change what an app may edit');

  return agent;
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(
      errorMessageFromResponse(await response.text(), response.status),
    );
  }

  return (await response.json()) as T;
}

export async function fetchRowGrant(
  store: Store,
  target: RowGrantTarget,
): Promise<RowGrantStatus> {
  const agent = signedIn(store);
  const url = new URL('/app-row-grant', store.getServerUrl());
  url.searchParams.set('drive', target.drive);
  url.searchParams.set('table', target.table);
  url.searchParams.set('app', target.app);
  const headers = await signRequest(url.href, agent, {});

  return parse<RowGrantStatus>(await fetch(url.href, { headers }));
}

async function post<T>(store: Store, body: Record<string, unknown>) {
  const agent = signedIn(store);
  const url = `${store.getServerUrl()}/app-row-grant`;

  // A write here requires a version 2 signature over exactly this body.
  return parse<T>(
    await fetch(
      url,
      await signedRequestInit(url, agent, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ),
  );
}

/** Records the signed-in person's grant, tied to `view` and the gesture. */
export function grantRowAccess(
  store: Store,
  target: RowGrantTarget & { view: string; via: RowGrantVia },
): Promise<RowGrant> {
  return post<RowGrant>(store, { op: 'grant', ...target }).then(grant => {
    notifyRowGrantChange();

    return grant;
  });
}

/** Takes the grant back. Resolves to what was revoked, or `null`. */
export function revokeRowAccess(
  store: Store,
  target: RowGrantTarget & { via?: 'menu' | 'view-removed' },
): Promise<RowGrant | null> {
  return post<RowGrant | null>(store, {
    op: 'revoke',
    via: 'menu',
    ...target,
  }).then(revoked => {
    notifyRowGrantChange();

    return revoked;
  });
}

/**
 * Whether the signed-in person may give or take back a grant on `table`:
 * someone who can edit it. The server checks the same, this is to know
 * whether to offer the question at all.
 */
export async function canGrantRows(
  store: Store,
  table: string,
): Promise<boolean> {
  const agent = store.getAgent();

  if (!agent) return false;

  const [canWrite] = await (
    await store.getResource(table)
  ).canWrite(agent.subject);

  return canWrite;
}

const listeners = new Set<() => void>();

/**
 * Called after this page grants or revokes, so the tab menu and an open app
 * see the same answer without polling. Returns an unsubscribe function.
 */
export function onRowGrantChange(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function notifyRowGrantChange(): void {
  for (const listener of listeners) listener();
}

/** What an app's `requestRowAccess()` resolves to. */
export type RowAccessAnswer =
  | { status: 'granted' }
  | { status: 'denied'; reason: string };

/**
 * Whether an app's `requestRowAccess()` needs the person at all. It does not
 * when the app is not a table's view here, when they could not grant it
 * anyway, or when it is already granted, including every row extra it now
 * declares; those are answered straight away. Otherwise the host shows the
 * confirmation, naming the app and saying whether it keeps extras on rows.
 */
export async function rowAccessQuestion(
  store: Store,
  {
    app,
    drive,
    table,
    view,
  }: { app: string; drive: string; table?: string; view?: string },
  appName: () => Promise<string>,
  declaredExtras: () => Promise<string[]> = () =>
    appRowExtras(store, drive, app),
): Promise<
  | { ask: false; result: RowAccessAnswer }
  | { ask: true; appName: string; extras: string[] }
> {
  if (!table || !view)
    return {
      ask: false,
      result: {
        status: 'denied',
        reason: /* @wc-ignore */ 'This app is not shown as a table view here',
      },
    };

  if (!(await canGrantRows(store, table)))
    return {
      ask: false,
      result: {
        status: 'denied',
        reason:
          /* @wc-ignore */ 'Only someone who can edit this table can allow that',
      },
    };

  const [{ grant }, extras] = await Promise.all([
    fetchRowGrant(store, { drive, table, app }),
    declaredExtras(),
  ]);

  // An app that now declares more than it was granted is asked about again:
  // the grant never stretches to cover a longer list by itself.
  if (grant && uncoveredExtras(grant, extras).length === 0)
    return { ask: false, result: { status: 'granted' } };

  return { ask: true, appName: await appName(), extras };
}
