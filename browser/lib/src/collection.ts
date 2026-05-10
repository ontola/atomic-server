import { isNumber } from './datatypes.js';
import { Collections, collections } from './ontologies/collections.js';
import { Resource } from './resource.js';
import { Store, StoreEvents } from './store.js';

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
  /**
   * subject → page index. Lets `applyResourceChange` answer "is this
   * subject already a member" in O(1) instead of scanning every loaded
   * page on every incoming `ResourceUpdated`. Maintained in lockstep
   * with `pages` via {@link setPage} / {@link clearPages}; the
   * applyResourceChange add/remove branches keep it consistent on
   * surgical mutations.
   */
  private _memberIndex = new Map<string, number>();
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
      // Route the initial fetch through `refresh()` rather than calling
      // `fetchPage(0)` directly. `refresh()` sets `_refreshInFlight`,
      // which `applyResourceChange` reads to know whether a late-
      // arriving matching subject (one whose `ResourceUpdated` event
      // fires while the initial WS `/query` GET is still blocked
      // behind auth) should set `_refreshPending` so the loop iterates
      // and re-queries the server. Without this, the matching subject
      // is silently dropped: the collection's pages stay empty and the
      // sidebar/table never reflects the just-created resource.
      // Reproducible under `ATOMIC_TEST_CPU_THROTTLE=5` via
      // `perf-sidebar-reload.spec.ts`.
      this._waitForReady = this.refresh();
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
    this._memberIndex.clear();
  }

  /** Write `members` + `totalMembers` propvals onto a page Resource. */
  private writePageMembers(
    page: Resource<Collections.Collection>,
    members: string[],
    total: number,
  ): void {
    page.applyHydratedValues([
      [collections.properties.members, members],
      [collections.properties.totalMembers, total],
    ]);
  }

  /** Stamp an empty page so callers see `pages.has(page) === true`
   * + `totalMembers === 0` as the authoritative "no children" state. */
  private setEmptyPage(page: number): void {
    const empty = new Resource<Collections.Collection>(this.buildSubject(page));
    this.writePageMembers(empty, [], 0);
    this.setPage(page, empty);
    this._totalMembers = 0;
  }

  /**
   * Single point that mutates `pages` so the member-subject index stays
   * in sync. Replaces any existing mapping for the same page index.
   */
  private setPage(
    pageIdx: number,
    resource: Resource<Collections.Collection>,
  ): void {
    // Drop the old page's members from the index first, then re-add the
    // new page's. Members can move between pages on `refresh`, so we
    // can't just additively merge.
    const existing = this.pages.get(pageIdx);
    if (existing) {
      for (const s of existing.getSubjects(collections.properties.members)) {
        if (this._memberIndex.get(s) === pageIdx) {
          this._memberIndex.delete(s);
        }
      }
    }
    this.pages.set(pageIdx, resource);
    for (const s of resource.getSubjects(collections.properties.members)) {
      this._memberIndex.set(s, pageIdx);
    }
  }

  /** Tracks an in-flight `refresh()` so concurrent callers reuse the same
   * promise instead of each kicking their own query. */
  private _refreshInFlight: Promise<void> | undefined;

  /** Set when `applyResourceChange` sees a new matching subject while a
   * refresh is already in flight. The active loop checks this after
   * `fetchPage` resolves and re-fetches if true — so the returned promise
   * resolves only AFTER the final state lands. Without this, a fast burst
   * of new matching resources (e.g. rapid row entry into a sorted table)
   * loses late arrivals: the in-flight `queryLocalDb` was queued before
   * they hit OPFS, no follow-up runs, and the cache stays stale until the
   * user reloads. */
  private _refreshPending = false;

  public async refresh(): Promise<void> {
    if (this._refreshInFlight) {
      this._refreshPending = true;

      return this._refreshInFlight;
    }

    this._refreshInFlight = (async () => {
      while (true) {
        this._refreshPending = false;
        this.clearPages();
        this._waitForReady = this.fetchPage(0);
        await this._waitForReady;
        if (!this._refreshPending) break;
      }
    })().finally(() => {
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
   *   - `'member-added'` — resource is new and matches the filter; we
   *     surgically append it to the last loaded page. The server already
   *     confirmed the resource exists (we got the actual resource object
   *     here, fetched in response to a `QUERY_UPDATE` push). Trusting that
   *     authority avoids the race where the server's `/query` index hasn't
   *     yet caught up with the just-applied commit — refresh would return
   *     stale state and the new row would never appear in the UI without
   *     a page reload.
   *   - `'membership-stale'` — a *possible* new member surfaced (e.g.
   *     locally-applied resource not yet pushed). The caller should
   *     `refresh()` so the server-authoritative count and ordering land.
   *     Used when we don't have a confirmed `resource` object.
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
  ): 'unchanged' | 'member-removed' | 'member-added' | 'membership-stale' {
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

    // O(1) lookup via the maintained subject→page index instead of
    // scanning every loaded page on every incoming event. The within-
    // page `indexOf` for the remove path stays — that's the array
    // splice position, which we don't track separately.
    const foundInPage = this._memberIndex.get(subject);
    const currentlyMember = foundInPage !== undefined;

    // Fast path for the overwhelming majority of events: a resource we
    // don't track had a property change that doesn't make it a member.
    // Bail before the more expensive add/remove logic below.
    if (!matches && !currentlyMember) return 'unchanged';

    if (matches && !currentlyMember) {
      // No page loaded yet — either constructor's initial `fetchPage(0)`
      // hasn't completed, or `refresh()`'s active loop just called
      // `clearPages()` and is mid-fetch. In the second case, mark a
      // follow-up so the loop iterates and includes this late arrival.
      if (!this.pages.has(0)) {
        if (this._refreshInFlight) this._refreshPending = true;

        return 'unchanged';
      }

      // Local-only drafts (`newResource()` created a genesis but no commit
      // has been signed-and-applied yet) shouldn't count as members.
      // `resource.new === true` until `signChanges` runs. Each
      // `TableNewRow` mounts and creates a draft with `parent` set;
      // without this filter every placeholder would be admitted as a
      // phantom row, and reloading an empty table would show 20+ ghost
      // rows. Once the resource is signed (and eventually pushed), it
      // fires another `ResourceUpdated` with `new=false` and lands here.
      if (resource.new) return 'unchanged';

      // Append to the last loaded page directly. This handles both
      // unsorted collections and the `createdAt`-sorted default (where
      // append IS correct order). Other sort keys (e.g. `name`) may
      // place the row at the wrong position until the next page reload
      // re-queries `fetchPageFromLocalDb` via the OPFS index.
      //
      // Why not refresh-via-OPFS for sorted collections? In principle
      // `Collection.refresh()` → `fetchPageFromLocalDb()` would
      // re-sort correctly, and OPFS already has the resource (its put
      // was queued in `addResource` before this event fired). The
      // chain mechanism in `refresh()` (`_refreshPending` loop) handles
      // bursts. In practice the loop didn't recover all rows during
      // fast-burst tests — debugging deferred. For now: trust direct
      // append for the common case; full re-sort on user reload.
      const lastPageIdx = Math.max(...this.pages.keys());
      const lastPage = this.pages.get(lastPageIdx)!;
      const members = lastPage.getSubjects(collections.properties.members);
      if (members.includes(subject)) return 'unchanged'; // paranoia
      this._totalMembers += 1;
      this._memberIndex.set(subject, lastPageIdx);
      this.writePageMembers(
        lastPage,
        [...members, subject],
        this._totalMembers,
      );

      return 'member-added';
    }

    if (!matches && currentlyMember) {
      // Resource no longer matches (deleted, or its `parent` changed). Strip
      // from the cached page in place — cheap, no fetch, and the count is
      // straightforwardly N-1 since we know the subject was a member.
      const page = this.pages.get(foundInPage!)!;
      const members = page.getSubjects(collections.properties.members);
      const idx = members.indexOf(subject);
      if (idx === -1) {
        // Index drift — the subject was indexed but not present on the
        // page. Drop the stale index entry and treat as no-op rather
        // than corrupt state further.
        this._memberIndex.delete(subject);
        return 'unchanged';
      }
      const next = [...members];
      next.splice(idx, 1);
      this._totalMembers = Math.max(0, this._totalMembers - 1);
      this._memberIndex.delete(subject);
      this.writePageMembers(page, next, this._totalMembers);
      return 'member-removed';
    }

    return 'unchanged';
  }

  public clone() {
    const collection = new Collection(this.store, this.server, this.params);
    collection._totalMembers = this._totalMembers;
    collection._waitForReady = this._waitForReady;
    collection.pages = this.pages;
    // Share the index too — both clones look at the same `pages` Map,
    // so they should observe the same membership.
    collection._memberIndex = this._memberIndex;

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

    const hasClientDb = !!this.store.getClientDb();

    // Race OPFS and server. Both `fetchPageFromLocalDb` and
    // `fetchPageFromServer` mutate `this.pages` on success — the second
    // one to land just overwrites with the same data, which is
    // harmless. The win is that OPFS check + server query no longer
    // run sequentially: if OPFS hits, we return as soon as it does;
    // if it misses, the server query is already in flight.
    //
    // For the OPFS-miss case this saves the OPFS round-trip latency
    // (~50–200 ms in dagger) on every cold-loaded collection.
    let serverPromise: Promise<void> | undefined;
    if (this.store.serverConnected) {
      // Fire-and-forget; we await later only if OPFS misses.
      serverPromise = this.fetchPageFromServer(page).catch(() => undefined);
    } else if (!hasClientDb) {
      // No OPFS *and* offline — give the WS a brief window to come up,
      // otherwise the constructor's `_waitForReady` would resolve to an
      // empty page and freeze the UI in a "no rows" state.
      await this.waitForServerConnected(3000);
      if (this.store.serverConnected) {
        serverPromise = this.fetchPageFromServer(page).catch(() => undefined);
      }
    }

    // Try OPFS. If the drive sync has already completed, an empty
    // result here is authoritative (the empty-fast path inside
    // `fetchPageFromLocalDb` returns 'ok' for empty + sync-completed).
    if (hasClientDb && (await this.fetchPageFromLocalDb(page)) === 'ok') {
      // OPFS won. The in-flight server fetch will land later and
      // overwrite with identical data — non-blocking, non-fatal.
      return;
    }

    // OPFS missed (or absent). Wait for the server result we kicked
    // off above. If we never started one (offline + no clientDb),
    // there's nothing to wait for — leave the page empty.
    if (serverPromise) {
      await serverPromise;
    }
  }

  private waitForServerConnected(timeoutMs: number): Promise<void> {
    if (this.store.serverConnected) return Promise.resolve();
    return new Promise<void>(resolve => {
      const unsub = this.store.on(
        StoreEvents.ConnectionChanged,
        (connected: boolean) => {
          if (connected) {
            unsub();
            clearTimeout(timer);
            resolve();
          }
        },
      );
      const timer = setTimeout(() => {
        unsub();
        resolve();
      }, timeoutMs);
    });
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
      this.setEmptyPage(page);

      return 'no-db';
    }

    if (result.count === 0) {
      // Empty local result is normally authoritative — but it's ambiguous
      // on a fresh page load before the drive sync has touched the store
      // yet (the index may be mid-populate). Once any drive sync has
      // completed we trust the empty: a freshly-created table or folder
      // just has no children. Pre-sync, fall back to `/query`.
      if (this.store.hasCompletedDriveSync()) {
        this.setEmptyPage(page);

        return 'ok';
      }
      return 'no-db';
    }

    if (
      result.resources &&
      result.resources.length === result.subjects.length
    ) {
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
      this.setEmptyPage(page);

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

        if (valA === null && valB === null) return 0;
        if (valA === null) return 1;
        if (valB === null) return -1;

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
    this.writePageMembers(resource, pageSubjects, result.count);
    this.setPage(page, resource);
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
      this.writePageMembers(resource, filteredMembers, filteredMembers.length);
    }

    this.setPage(page, resource);

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
