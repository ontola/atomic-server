/**
 * LocalSearch: client-side full-text search powered by MiniSearch.
 *
 * Indexes resource fields (name, description, shortname) for fast
 * prefix/fuzzy search without a server round-trip.
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

export class LocalSearch {
  private index: MiniSearch;

  constructor() {
    this.index = new MiniSearch({
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

  /** Add or update a resource in the search index. */
  addResource(resource: Resource): void {
    if (!resource.subject || resource.loading || resource.new) return;

    const doc = this.resourceToDoc(resource);

    if (!doc) return;

    // MiniSearch throws if you add a duplicate ID — remove first if exists
    if (this.index.has(doc.id)) {
      this.index.discard(doc.id);
    }

    this.index.add(doc);
  }

  /** Remove a resource from the search index. */
  removeResource(subject: string): void {
    if (this.index.has(subject)) {
      this.index.discard(subject);
    }
  }

  /** Search the local index. Returns matching subject URLs ordered by relevance. */
  search(query: string, limit = 30): LocalSearchResult {
    if (!query.trim()) {
      return { subjects: [] };
    }

    const results: SearchResult[] = this.index.search(query);

    return {
      subjects: results.slice(0, limit).map(r => r.id),
    };
  }

  /** Number of documents in the index. */
  get size(): number {
    return this.index.documentCount;
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
