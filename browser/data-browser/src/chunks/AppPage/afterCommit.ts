import {
  errorMessageFromResponse,
  signRequest,
  signedRequestInit,
  type Store,
} from '@tomic/react';
import type { RowGrantVia } from './rowGrant';

/**
 * An app's durable `afterCommit` hook (#1851): a plugin shown as a table's
 * view is told when the table's rows change, also while the tab is closed.
 *
 * The server keeps one subscription per app and table
 * (`server/src/plugins/after_commit.rs`). Adding the app as the table's view
 * makes one, whether the person allows editing or not (decision 1). Edits
 * the hook proposes without a grant wait on the table's tab (decision 2), a
 * hook that keeps failing shows a quiet warning with Retry (decision 3), and
 * while a proposal waits the app is paused on that table (decision 4).
 */
export interface AfterCommitPending {
  /** Rows (and other resources) the proposal would change. */
  rows: number;
  subjects: string[];
  /** Every change stays within what "Allow editing" covers. */
  inScope: boolean;
  at: number;
}

export interface AfterCommitStopped {
  reason: string;
  at: number;
  attempts: number;
}

export interface AfterCommitSubscription {
  table: string;
  view: string;
  app: string;
  installation?: string | null;
  via: string;
  activatedBy: string;
  activatedAt: number;
  lastDeliveredAt?: number | null;
  lastError?: string | null;
  stopped?: AfterCommitStopped | null;
  pending?: AfterCommitPending | null;
  attempts: number;
  /** Changes are waiting to be delivered. */
  waiting: boolean;
}

export interface AfterCommitStatus {
  /** The server runs with `--plugin-after-commit`. */
  enabled: boolean;
  /** The app exports `afterCommit`, so adding it as a view follows the table. */
  declares: boolean;
  subscriptions: AfterCommitSubscription[];
}

export type AfterCommitAnswer = 'apply' | 'allow-all' | 'decline' | 'retry';

export interface AfterCommitTarget {
  drive: string;
  app: string;
  table?: string;
}

const NONE: AfterCommitStatus = {
  enabled: false,
  declares: false,
  subscriptions: [],
};

function signedIn(store: Store) {
  const agent = store.getAgent();

  if (!agent) throw new Error('Sign in to see what an app does with changes');

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

/** What the app's hook is doing on one table, or on every table it follows. */
export async function fetchAfterCommit(
  store: Store,
  target: AfterCommitTarget,
): Promise<AfterCommitStatus> {
  const agent = store.getAgent();

  if (!agent) return NONE;

  const url = new URL('/app-after-commit', store.getServerUrl());
  url.searchParams.set('drive', target.drive);
  url.searchParams.set('app', target.app);

  if (target.table) url.searchParams.set('table', target.table);

  const headers = await signRequest(url.href, agent, {});
  const response = await fetch(url.href, { headers });

  // A server without the endpoint (no plugin runtime) has no hook either.
  if (response.status === 404) return NONE;

  return parse<AfterCommitStatus>(response);
}

async function post<T>(store: Store, path: string, body: object): Promise<T> {
  const agent = signedIn(store);
  const url = `${store.getServerUrl()}${path}`;

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

/**
 * The Read-only answer to "Let <App> edit rows?": no grant, but the app
 * follows the table's changes all the same. "Allow editing" does both on
 * the server in one request. Resolves to `null` when the hook is off or the
 * app does not export it.
 */
export function followTable(
  store: Store,
  target: Required<AfterCommitTarget> & { view: string; via: RowGrantVia },
): Promise<AfterCommitSubscription | null> {
  return post<AfterCommitSubscription | null>(store, '/app-row-grant', {
    op: 'follow',
    ...target,
  }).then(sub => {
    notifyAfterCommitChange();

    return sub;
  });
}

/** Answers the proposal waiting on the table, or retries a stopped table. */
export function answerAfterCommit(
  store: Store,
  target: Required<AfterCommitTarget> & { op: AfterCommitAnswer },
): Promise<AfterCommitSubscription> {
  return post<AfterCommitSubscription>(store, '/app-after-commit', target).then(
    sub => {
      notifyAfterCommitChange();

      return sub;
    },
  );
}

const listeners = new Set<() => void>();

/** Called after this page answers or retries, so every view refreshes. */
export function onAfterCommitChange(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function notifyAfterCommitChange(): void {
  for (const listener of listeners) listener();
}

/** Proposed edits waiting across every table the app follows. */
export function pendingRows(subscriptions: AfterCommitSubscription[]): number {
  return subscriptions.reduce((sum, s) => sum + (s.pending?.rows ?? 0), 0);
}

/** The subscriptions that stopped and need a Retry. */
export function stoppedTables(
  subscriptions: AfterCommitSubscription[],
): AfterCommitSubscription[] {
  return subscriptions.filter(s => !!s.stopped);
}
