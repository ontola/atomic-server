import {
  errorMessageFromResponse,
  signRequest,
  type Store,
} from '@tomic/react';

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
  revokedAt?: number;
  revokedBy?: string;
  revokedVia?: RowRevokeVia;
}

/**
 * The gesture that gave a grant: adding the app from "+ Add view", switching
 * a tab to it in "View type", the app's own request, or the tab's menu.
 */
export type RowGrantVia = 'add-view' | 'view-type' | 'request' | 'menu';

/** What ended one. The last two are recorded by the server itself. */
export type RowRevokeVia =
  | 'menu'
  | 'view-removed'
  | 'view-kind-changed'
  | 'granter-lost-write'
  | 'app-key-changed';

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
  const headers = await signRequest(url, agent, {});

  return parse<T>(
    await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
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
 * anyway, or when it is already granted; those are answered straight away.
 * Otherwise the host shows the confirmation, naming the app.
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
): Promise<
  { ask: false; result: RowAccessAnswer } | { ask: true; appName: string }
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

  const { grant } = await fetchRowGrant(store, { drive, table, app });

  if (grant) return { ask: false, result: { status: 'granted' } };

  return { ask: true, appName: await appName() };
}
