import { Collection, CollectionParams, PropVal } from './collection.js';
import { Store } from './store.js';

export class CollectionBuilder {
  private store: Store;
  private server: string;

  private params: CollectionParams = {
    page_size: '30',
    include_nested: false,
    drive: undefined,
  };

  public constructor(store: Store, server?: string) {
    this.store = store;
    this.server = server ?? new URL(store.getServerUrl()).origin;
    // Default the drive filter to the active drive DID. The old fallback
    // was `this.server` (a URL like `http://localhost:9883`), which the
    // server then tried to filter `drive == <server-origin>` against —
    // never matched any real resource (resources are scoped by drive DID),
    // so every default-drive query returned zero rows.
    const activeDrive = store.getDrive();
    this.params.drive = this.params.drive ?? activeDrive;
  }

  public setProperty(property: string): CollectionBuilder {
    this.params.property = property;

    return this;
  }

  public setValue(value: string): CollectionBuilder {
    this.params.value = value;

    return this;
  }

  /**
   * Adds an extra `(property, value)` constraint, combined with the rest using
   * **AND**. Call multiple times to filter on multiple properties, e.g.
   * `.setProperty(isA).setValue(commit).addFilter({ property: signer, value: agent })`.
   */
  public addFilter(filter: PropVal): CollectionBuilder {
    this.params.filters = [...(this.params.filters ?? []), filter];

    return this;
  }

  /** Replaces all extra AND constraints at once. */
  public setFilters(filters: PropVal[]): CollectionBuilder {
    this.params.filters = filters;

    return this;
  }

  public setSortBy(sortBy: string): CollectionBuilder {
    this.params.sort_by = sortBy;

    return this;
  }

  public setSortDesc(sortDesc: boolean): CollectionBuilder {
    this.params.sort_desc = sortDesc;

    return this;
  }

  public setPageSize(pageSize: number): CollectionBuilder {
    this.params.page_size = `${pageSize}`;

    return this;
  }

  public setIncludeNested(includeNested: boolean): CollectionBuilder {
    this.params.include_nested = includeNested;

    return this;
  }

  public setDrive(drive: string): CollectionBuilder {
    this.params.drive = drive;

    return this;
  }

  public build(): Collection {
    return new Collection(this.store, this.server, this.params);
  }

  public async buildAndFetch(): Promise<Collection> {
    const collection = this.build();

    await collection.waitForReady();

    return collection;
  }
}
