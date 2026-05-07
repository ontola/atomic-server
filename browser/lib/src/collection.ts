import { isNumber } from './datatypes.js';
import { Collections, collections } from './ontologies/collections.js';
import { Resource } from './resource.js';
import { Store } from './store.js';

/**
 * Cooldown between consecutive `'membership-stale'` returns from a single
 * collection. See the comment in `applyResourceChange` for the rationale.
 */
const STALE_COOLDOWN_MS = 250;

/**
 * Strips `did:ad:commit:` subjects from a member list. Commit resources don't
 * have user-facing properties like `parent` or `messages`, but a hydration
 * bug elsewhere can register the committed-resource's atoms under the commit
 * subject (importing a Commit's `loroUpdate` field into the Commit's own
 * propvals). Filtering at the collection-iterator boundary keeps the leak
 * from showing up in chatroom message lists, sidebar children, table rows,
 * etc., regardless of whether the corruption came from the local or server-
 * side index. The proper fix is upstream — see TODO.
 */
function filterIndexLeakage(subjects: string[]): string[] {
  return subjects.filter(s => !s.startsWith('did:ad:commit:'));
}

export interface QueryFilter {
  property?: string;
  value?: string;
  sort_by?: string;
  sort_desc?: boolean;
  drive?: string;
}

export interface CollectionParams extends QueryFilter {
  page_size: string;
  include_nested: boolean;
}

export interface CollectionOptions {
  noFetch?: boolean;
  endpoint?: string;
}

/**
 * A collection is a dynamic resource that queries the server for a list of resources that meet it's criteria.
 * Checkout [the docs](https://docs.atomicdata.dev/schema/collections.html) for more information.
 *
 * Keep in mind that the collection does currently not subscribe to changes in the store and will therefore not update if items are added or removed.
 * Use the `invalidate` method to force a refresh.
 */
export class Collection {
  public readonly __internalObject = this;
  private store: Store;
  private pages = new Map<number, Resource<Collections.Collection>>();
  private server: string;
  private params: CollectionParams;

  private _totalMembers = 0;

  private _waitForReady: Promise<void>;

  public constructor(
    store: Store,
    server: string,
    params: CollectionParams,
    noFetch = false,
  ) {
    this.store = store;
    this.server = server;
    this.params = params;

    if (!noFetch) {
      this._waitForReady = this.fetchPage(0);
    }

    this.clearPages = this.clearPages.bind(this);
  }

  public get property(): string | undefined {
    return this.params.property;
  }

  public get value(): string | undefined {
    return this.params.value;
  }

  public get sortBy(): string | undefined {
    return this.params.sort_by;
  }

  public get sortDesc(): boolean {
    return !!this.params.sort_desc;
  }

  public get pageSize(): number {
    return parseInt(this.params.page_size, 10);
  }

  public get totalMembers(): number {
    return this._totalMembers;
  }

  public get totalPages(): number {
    return Math.ceil(this.totalMembers / this.pageSize);
  }

  public waitForReady(): Promise<void> {
    return this._waitForReady;
  }

  public async getMemberWithIndex(index: number): Promise<string | undefined> {
    if (index >= this.totalMembers) {
      throw new Error('Index out of bounds');
    }

    const page = Math.floor(index / this.pageSize);

    if (!this.pages.has(page)) {
      this._waitForReady = this.fetchPage(page);
      await this._waitForReady;
    }

    // `fetchPage` short-circuits without populating `pages` when there's
    // nothing to filter by or when local + server fetches both fail. Don't
    // crash the consumer — return undefined so iterators just skip the slot.
    const resource = this.pages.get(page);
    if (!resource) return undefined;

    const members = filterIndexLeakage(
      resource.getSubjects(collections.properties.members),
    );

    return members[index % this.pageSize];
  }

  public clearPages(): void {
    this.pages = new Map();
  }

  /** Tracks an in-flight `refresh()` so concurrent callers reuse the same
   * promise instead of each kicking their own `/query` fetch. Without this,
   * a burst of `ResourceUpdated` events during sync (each routed through
   * `applyResourceChange → 'membership-stale' → invalidateCollection`)
   * would fire dozens of identical GETs in parallel. */
  private _refreshInFlight: Promise<void> | undefined;

  /** `performance.now()` of the last `'membership-stale'` return, used to
   * coalesce bursts of stale signals into a single refresh. */
  private _lastStaleAt = -Infinity;

  public async refresh(): Promise<void> {
    if (this._refreshInFlight) return this._refreshInFlight;

    this.clearPages();
    this._waitForReady = this.fetchPage(0);
    this._refreshInFlight = this._waitForReady.finally(() => {
      this._refreshInFlight = undefined;
    });

    return this._refreshInFlight;
  }

  /**
   * Decide whether a single-resource change is relevant to this collection's
   * filter. Returns one of:
   *   - `'unchanged'` — not a member, not affected, do nothing
   *   - `'member-removed'` — resource was a member and isn't anymore; we
   *     surgically strip it from the cached page (cheap, no network)
   *   - `'membership-stale'` — a matching resource appeared (or could have);
   *     the caller should `refresh()` so the server-authoritative count and
   *     ordering land. We deliberately don't compute the new total locally:
   *     trying to track membership without the server as source-of-truth led
   *     to drift (count grew past the server's actual page count, the table
   *     virtualizer asked for pages that don't exist, server replied with
   *     `Page number out of bounds`, the catch swallowed the error, and the
   *     consumer's `useEffect([collection, index])` retried on every proxy
   *     re-emit — flooding `/query` GETs).
   *
   * The storm reduction this is designed for is still real: only collections
   * whose filter matches the change ever invalidate. Unrelated collections
   * (sidebar children of *other* folders, ontology lists, etc.) ignore.
   *
   * Pass `resource: undefined` to signal a removal.
   */
  public applyResourceChange(
    subject: string,
    resource: Resource | undefined,
  ): 'unchanged' | 'member-removed' | 'membership-stale' {
    const fp = this.params.property;
    const fv = this.params.value;

    // No filter, nothing to evaluate. Same short-circuit as `fetchPage`.
    if (!fp || !fv) return 'unchanged';

    // Commit subjects leak into `parent=` indexes on both server and client.
    // `filterIndexLeakage` strips them at iteration; mirror that here so we
    // don't even consider treating one as a member.
    if (subject.startsWith('did:ad:commit:')) return 'unchanged';

    // `_new:` is the placeholder subject the store assigns before async
    // signing renames the resource to its real DID. The placeholder is UI
    // scaffold (e.g. `TableNewRow` pre-populates parent so the empty editor
    // row renders) and must not affect membership.
    if (subject.startsWith('_new:')) return 'unchanged';

    // `r.get(fp)` is a string for single-valued properties (e.g. `parent`)
    // and an array for multi-valued ones (e.g. `isA`). Match like
    // server-side `/query` does ("value-in-property").
    const propVal = resource?.get(fp);
    const matches =
      !!resource &&
      (Array.isArray(propVal) ? propVal.includes(fv) : propVal === fv);

    let foundInPage: number | undefined;
    let foundIndex = -1;
    for (const [pageIdx, page] of this.pages) {
      const members = page.getSubjects(collections.properties.members);
      const idx = members.indexOf(subject);
      if (idx !== -1) {
        foundInPage = pageIdx;
        foundIndex = idx;
        break;
      }
    }

    const currentlyMember = foundInPage !== undefined;

    if (matches && !currentlyMember) {
      // Refresh is already in flight — it'll pick this subject up.
      if (this._refreshInFlight) return 'unchanged';

      // No page loaded yet — constructor's initial `fetchPage(0)` is in
      // flight; it'll see this subject in the server response.
      if (!this.pages.has(0)) return 'unchanged';

      // Rate-limit invalidations. Without this, a burst of matching
      // resources arriving in sequence (e.g. local-only / pending /
      // sync-streamed children of this filter's parent) each fires
      // `'membership-stale'` *after* the previous refresh has resolved
      // and `_refreshInFlight` cleared. Each kicks a fresh refresh →
      // setCollection → re-render. Sequential setCollection cycles
      // eventually trip React's setState-depth cap and surface as
      // "Maximum update depth exceeded" when opening a populated
      // collection. A 250ms cooldown collapses the burst into one
      // refresh; subsequent legitimate changes (separated in time) still
      // fire stale and trigger their own refresh.
      const now =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - this._lastStaleAt < STALE_COOLDOWN_MS) return 'unchanged';
      this._lastStaleAt = now;

      return 'membership-stale';
    }

    if (!matches && currentlyMember) {
      // Resource no longer matches (deleted, or its `parent` changed). Strip
      // from the cached page in place — cheap, no fetch, and the count is
      // straightforwardly N-1 since we know the subject was a member.
      const page = this.pages.get(foundInPage!)!;
      const members = page.getSubjects(collections.properties.members);
      const next = [...members];
      next.splice(foundIndex, 1);
      this._totalMembers = Math.max(0, this._totalMembers - 1);
      page.applyHydratedValues([
        [collections.properties.members, next],
        [collections.properties.totalMembers, this._totalMembers],
      ]);
      return 'member-removed';
    }

    return 'unchanged';
  }

  public clone() {
    const collection = new Collection(this.store, this.server, this.params);
    collection._totalMembers = this._totalMembers;
    collection._waitForReady = this._waitForReady;
    collection.pages = this.pages;

    return collection;
  }

  public async *[Symbol.asyncIterator]() {
    await this.waitForReady();

    for (let i = 0; i < this.totalMembers; i++) {
      const member = await this.getMemberWithIndex(i);

      if (member === undefined) {
        continue;
      }

      yield member;
    }
  }

  public async getAllMembers(): Promise<string[]> {
    const members: string[] = [];

    for await (const member of this) {
      members.push(member);
    }

    return members;
  }

  public async getMembersOnPage(page: number): Promise<string[]> {
    if (!this.pages.has(page)) {
      await this.fetchPage(page);
    }

    const resource = this.pages.get(page);

    if (!resource) {
      return [];
    }

    return filterIndexLeakage(
      (resource.props.members ?? []).filter(m => m !== undefined),
    );
  }

  private buildSubject(page: number): string {
    const url = new URL(`${this.server}/query`);

    for (const [key, value] of Object.entries(this.params)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }

    url.searchParams.set('current_page', `${page}`);

    return url.toString();
  }

  private async fetchPage(page: number): Promise<void> {
    // No-op when there's nothing to filter by. Without this, callers who
    // pass an undefined `value` (e.g. `useChildren(undefined)` for tables
    // and chatrooms that render children in their own UI) would fall
    // through to a server fetch that returns *every* resource with the
    // given property — wasted bandwidth and a real source of WS-storm
    // refetches from `QUERY_UPDATE` events.
    if (!this.params.property || !this.params.value) {
      return;
    }

    // Try the local WASM DB first.
    if ((await this.fetchPageFromLocalDb(page)) === 'ok') {
      return;
    }

    // Local DB couldn't answer (no clientDb, or query errored). Wait for
    // first drive-sync to complete in case the index is mid-populate, then
    // retry once.
    if (this.store.serverConnected) {
      await this.store.waitForFirstDriveSync();
      if ((await this.fetchPageFromLocalDb(page)) === 'ok') {
        return;
      }
    }

    // No local DB at all (Tauri or user-disabled). Server `/query` is the
    // only option here.
    if (!this.store.serverConnected) {
      return;
    }

    try {
      await this.fetchPageFromServer(page);
    } catch {
      // Server unreachable and no local data — leave collection empty
    }
  }

  /**
   * Resolve a page from the local WASM DB. Returns:
   *   - `'ok'` — query ran and the page is populated (possibly with zero
   *     members, which is a legitimate empty result for this filter).
   *   - `'no-db'` — local DB isn't available (no clientDb, or query failed).
   *     Caller may fall back to a server `/query`.
   *
   * After the first drive-sync the WASM index is the source of truth for
   * `parent=…` queries; an empty result means "this parent really has no
   * children", not "I haven't loaded yet". Falling back to a server
   * `/query` in that case just produces redundant traffic — sync already
   * delivered everything the server has.
   */
  private async fetchPageFromLocalDb(page: number): Promise<'ok' | 'no-db'> {
    // Both property and value are required for a meaningful local query.
    if (!this.params.property || !this.params.value) {
      return 'no-db';
    }

    // Wait for WASM DB to be ready (important on initial page load).
    const clientDb = this.store.getClientDb();

    if (clientDb && !clientDb.isReady) {
      await clientDb.waitForReady();
    }

    if (!clientDb || !clientDb.isReady) {
      return 'no-db';
    }

    // Query without sort — sorted queries with DID drives don't work in the
    // WASM DB yet (drive-scoped index keys don't match DID subjects).
    // We fetch all matching subjects with their JSON-AD payloads, hydrate
    // them into the store, and sort client-side. Hydrating up front matters:
    // immediately after a page reload `store.resources` is empty, so without
    // it the sort key lookup returns `undefined` for every member and the
    // sort silently degrades to the index's natural order.
    const result = await this.store.queryLocalDb({
      property: this.params.property,
      value: this.params.value,
      includeResources: true,
    });

    // Build a synthetic page resource even when the result is empty —
    // `pages.has(page) === true` then signals to `applyResourceChange`
    // that this collection's first page is loaded, and to consumers that
    // `totalMembers === 0` is a real, server-authoritative answer rather
    // than a "still fetching" placeholder.
    if (!result) {
      const empty = new Resource<Collections.Collection>(
        this.buildSubject(page),
      );
      empty.applyHydratedValues([
        [collections.properties.members, []],
        [collections.properties.totalMembers, 0],
      ]);
      this.pages.set(page, empty);
      this._totalMembers = 0;
      return 'no-db';
    }

    if (result.count === 0) {
      const empty = new Resource<Collections.Collection>(
        this.buildSubject(page),
      );
      empty.applyHydratedValues([
        [collections.properties.members, []],
        [collections.properties.totalMembers, 0],
      ]);
      this.pages.set(page, empty);
      this._totalMembers = 0;
      return 'ok';
    }

    if (result.resources && result.resources.length === result.subjects.length) {
      for (let i = 0; i < result.subjects.length; i++) {
        this.store.hydrateResourceFromJsonAd(
          result.subjects[i]!,
          result.resources[i]!,
        );
      }
    }

    // Strip commit subjects from BOTH the subjects array AND the count.
    // Filtering only at iteration time (`getMemberWithIndex`) leaves the
    // inflated count in `collection.totalMembers`, so consumers like
    // `TableResource` and react-window render an empty `TableRow` slot
    // for the missing index that gets stuck on a loading shimmer. Stripping
    // here keeps the count and the addressable members consistent.
    result.subjects = filterIndexLeakage(result.subjects);
    result.count = result.subjects.length;

    if (result.subjects.length === 0) {
      const empty = new Resource<Collections.Collection>(
        this.buildSubject(page),
      );
      empty.applyHydratedValues([
        [collections.properties.members, []],
        [collections.properties.totalMembers, 0],
      ]);
      this.pages.set(page, empty);
      this._totalMembers = 0;
      return 'ok';
    }

    // Client-side sorting — pre-fetch sort keys to avoid repeated Map lookups.
    const sortBy = this.params.sort_by;

    if (sortBy) {
      const sortDesc = !!this.params.sort_desc;
      const sortKeys = new Map<string, unknown>();

      for (const s of result.subjects) {
        sortKeys.set(s, this.store.resources.get(s)?.get(sortBy));
      }

      result.subjects.sort((a, b) => {
        const valA = sortKeys.get(a);
        const valB = sortKeys.get(b);

        if (valA == null && valB == null) return 0;
        if (valA == null) return 1;
        if (valB == null) return -1;

        const cmp =
          typeof valA === 'number' && typeof valB === 'number'
            ? valA - valB
            : String(valA).localeCompare(String(valB));

        return sortDesc ? -cmp : cmp;
      });
    }

    // Client-side pagination
    const pageSize = parseInt(this.params.page_size, 10);
    const offset = page * pageSize;
    const pageSubjects = result.subjects.slice(offset, offset + pageSize);

    // Build a synthetic collection resource from the query result
    const resource = new Resource<Collections.Collection>(
      this.buildSubject(page),
    );
    resource.applyHydratedValues([
      [collections.properties.members, pageSubjects],
      [collections.properties.totalMembers, result.count],
    ]);

    this.pages.set(page, resource);
    this._totalMembers = result.count;

    return 'ok';
  }

  private async fetchPageFromServer(page: number): Promise<void> {
    const subject = this.buildSubject(page);
    const resource =
      await this.store.fetchResourceFromServer<Collections.Collection>(subject);

    if (!resource) {
      throw new Error('Invalid collection: resource does not exist');
    }

    if (resource.error) {
      throw new Error(
        `Invalid collection: resource has error: ${resource.error}`,
      );
    }

    // Same leak as `fetchPageFromLocalDb`: the server's atom-by-atom index
    // can register a Commit's `subject` (a `did:ad:commit:` URI) under the
    // committed-resource's parent, so a `parent=<table>` query comes back
    // with phantom commit-id members that point at nothing useful for
    // table-row rendering. Strip them and recount so the synthetic
    // collection page exposes the right `totalMembers`.
    const rawMembers = (resource.props.members ?? []).filter(
      (m): m is string => m !== undefined,
    );
    const filteredMembers = filterIndexLeakage(rawMembers);
    if (filteredMembers.length !== rawMembers.length) {
      resource.applyHydratedValues([
        [collections.properties.members, filteredMembers],
        [collections.properties.totalMembers, filteredMembers.length],
      ]);
    }

    this.pages.set(page, resource);

    const totalMembers = resource.props.totalMembers;

    if (!isNumber(totalMembers)) {
      throw new Error('Invalid collection: total-members is not a number');
    }

    this._totalMembers = totalMembers;
  }
}

export function proxyCollection(collection: Collection): Collection {
  if (collection.__internalObject !== collection) {
    console.warn('Attempted to proxy a proxy for a collection');
  }

  return new Proxy(collection.__internalObject, {});
}
