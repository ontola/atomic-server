/**
 * LocalSearch: client-side full-text search powered by MiniSearch.
 *
 * Indexes resource fields (name, description, shortname) for fast
 * prefix/fuzzy search without a server round-trip.
 *
 * One index PER DRIVE. A single global index leaks results across drives
 * and surfaces the bootstrap ontology (the `atomicdata.dev` drive's classes
 * and properties) when a user searches their own drive. Partitioning by
 * drive keeps each search scoped to exactly the drive being browsed —
 * matching the server's `parents`-scoped search.
 */

import MiniSearch, { type SearchResult } from 'minisearch';
import { core } from './ontologies/core.js';
import type { Resource } from './resource.js';

/** Fields we extract from resources for indexing */
const INDEXED_FIELDS = ['name', 'description', 'shortname'] as const;

/** Map from our short field names to Atomic Data property URLs */
const FIELD_TO_PROP: Record<string, string> = {
  name: core.properties.name,
  description: core.properties.description,
  shortname: core.properties.shortname,
};

export interface LocalSearchResult {
  /** Subject URLs of matching resources, ordered by relevance */
  subjects: string[];
}

/** Commits are write-time metadata, never searchable content. */
function isCommitSubject(subject: string): boolean {
  return subject.startsWith('did:ad:commit:');
}

export class LocalSearch {
  /** One MiniSearch index per drive subject. */
  private indexes = new Map<string, MiniSearch>();

  private createIndex(): MiniSearch {
    return new MiniSearch({
      fields: [...INDEXED_FIELDS],
      storeFields: [],
      idField: 'id',
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        boost: { name: 3, shortname: 2, description: 1 },
      },
    });
  }

  private indexForDrive(drive: string): MiniSearch {
    let index = this.indexes.get(drive);

    if (!index) {
      index = this.createIndex();
      this.indexes.set(drive, index);
    }

    return index;
  }

  /**
   * Add or update a resource in its drive's search index.
   * `drive` is the subject of the drive the resource belongs to.
   */
  addResource(resource: Resource, drive: string): void {
    if (!resource.subject || resource.loading || resource.new || !drive) {
      return;
    }

    // Commits are not searchable content — skip them.
    if (isCommitSubject(resource.subject)) {
      return;
    }

    const doc = this.resourceToDoc(resource);

    if (!doc) {
      return;
    }

    const index = this.indexForDrive(drive);

    // MiniSearch throws if you add a duplicate ID — remove first if exists.
    if (index.has(doc.id)) {
      index.discard(doc.id);
    }

    index.add(doc);
  }

  /**
   * Remove a resource from the search index. The drive is usually unknown
   * at removal time, so sweep every drive's index.
   */
  removeResource(subject: string): void {
    for (const index of this.indexes.values()) {
      if (index.has(subject)) {
        index.discard(subject);
      }
    }
  }

  /**
   * Search one drive's index. Returns matching subject URLs ordered by
   * relevance. An unknown drive yields no results.
   */
  search(query: string, drive: string, limit = 30): LocalSearchResult {
    const index = this.indexes.get(drive);

    if (!index || !query.trim()) {
      return { subjects: [] };
    }

    const results: SearchResult[] = index.search(query);

    return {
      subjects: results.slice(0, limit).map(r => r.id),
    };
  }

  /** Number of documents indexed for a specific drive. */
  sizeForDrive(drive: string): number {
    return this.indexes.get(drive)?.documentCount ?? 0;
  }

  /** Total documents across every drive's index. */
  get size(): number {
    let total = 0;

    for (const index of this.indexes.values()) {
      total += index.documentCount;
    }

    return total;
  }

  /** Extract searchable fields from a Resource. Returns null if nothing to index. */
  private resourceToDoc(
    resource: Resource,
  ): { id: string; [key: string]: string } | null {
    const doc: { id: string; [key: string]: string } = {
      id: resource.subject,
    };

    let hasContent = false;

    for (const field of INDEXED_FIELDS) {
      const prop = FIELD_TO_PROP[field];

      if (!prop) continue;

      const value = resource.get(prop);

      if (typeof value === 'string' && value.length > 0) {
        doc[field] = value;
        hasContent = true;
      }
    }

    return hasContent ? doc : null;
  }
}
