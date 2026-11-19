/**
 * The per-table change list (atomic-server #1850): rows of a table that
 * changed since an opaque cursor, including rows that left it (tombstones),
 * each with its Loro version so a caller can diff fields against its own
 * baseline. "Hook for speed, change list for correctness."
 *
 * A table is a resource of class `Table` with a `classtype`; its rows are its
 * children of that class. Served by `GET /changes?table=&since=&limit=` on the
 * connected server; see `docs/src/changes.md`.
 */

import { signRequest } from './authentication.js';
import type { Agent } from './agent.js';

export type TableChangeKind = 'created' | 'updated' | 'deleted';

export interface TableChange {
  /** The row's subject. */
  subject: string;
  /**
   * `created`: the row entered the table (created, moved in, given the class).
   * `updated`: edited and still in the table. `deleted`: left the table
   * (destroyed, moved out, lost the class). Only the latest change per row is
   * kept, so treat `created` and `updated` alike (upsert).
   */
  kind: TableChangeKind;
  /**
   * The row's Loro version vector after the change, peer id to counter:
   * `VersionVector.parseJSON(new Map(Object.entries(version)))`. For
   * `deleted`, the last version the server held. Null when it had none.
   */
  version: Record<string, number> | null;
  /** When the server recorded the change, Unix milliseconds. */
  at: number;
}

export interface TableChangesPage {
  changes: TableChange[];
  /** Pass back as `since` to continue. */
  cursor: string;
  /** More changes are waiting; ask again with `cursor` right away. */
  hasMore: boolean;
}

export interface TableChangesOptions {
  /** A cursor from an earlier page. Omit to list every current row. */
  since?: string;
  /** Page size; the server caps it at 500 (default 100). */
  limit?: number;
}

/**
 * The cursor predates the server's tombstone retention (or the table's rows
 * were redefined). Resync: list again without `since` and reconcile.
 */
export class TableChangesCursorExpiredError extends Error {
  public readonly code = 'CURSOR_EXPIRED';

  public constructor(message = 'Change list cursor expired; resync') {
    super(message);
    this.name = 'TableChangesCursorExpiredError';
  }
}

/** Parse the server's JSON. Throws on anything malformed. */
export function parseTableChangesPage(input: unknown): TableChangesPage {
  if (!input || typeof input !== 'object') {
    throw new Error('Malformed change list page');
  }

  const data = input as Record<string, unknown>;

  if (
    !Array.isArray(data.changes) ||
    typeof data.cursor !== 'string' ||
    typeof data.hasMore !== 'boolean'
  ) {
    throw new Error('Malformed change list page');
  }

  const changes = data.changes.map((raw): TableChange => {
    const c = raw as Record<string, unknown>;

    if (
      typeof c.subject !== 'string' ||
      (c.kind !== 'created' && c.kind !== 'updated' && c.kind !== 'deleted') ||
      typeof c.at !== 'number'
    ) {
      throw new Error('Malformed change list entry');
    }

    const version =
      c.version && typeof c.version === 'object'
        ? (c.version as Record<string, number>)
        : null;

    return { subject: c.subject, kind: c.kind, version, at: c.at };
  });

  return { changes, cursor: data.cursor, hasMore: data.hasMore };
}

/** `GET /changes` against `serverUrl`, signed by `agent` when given. */
export async function fetchTableChanges(
  serverUrl: string,
  agent: Agent | undefined,
  table: string,
  opts: TableChangesOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<TableChangesPage> {
  const url = new URL('/changes', serverUrl);
  url.searchParams.set('table', table);

  if (opts.since) url.searchParams.set('since', opts.since);
  if (opts.limit !== undefined) url.searchParams.set('limit', `${opts.limit}`);

  // The server rebuilds the signed message from the full request URL.
  const headers = agent
    ? await signRequest(url.toString(), agent, { Accept: 'application/json' })
    : { Accept: 'application/json' };
  const res = await fetchImpl(url.toString(), { headers });

  if (res.status === 410) {
    const body = await res.json().catch(() => ({}));
    throw new TableChangesCursorExpiredError(body?.message);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Change list for ${table} failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }

  return parseTableChangesPage(await res.json());
}
