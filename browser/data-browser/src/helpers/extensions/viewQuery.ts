// @wc-ignore-file
import { Client, CollectionBuilder, type Store } from '@tomic/react';

/**
 * A collection query a view may run: the subset of `CollectionBuilder` a
 * frame can ask for, under the same names. Both hosts answer it the same way.
 */
export interface ViewQuery {
  property?: string;
  value?: string;
  filters: { property: string; value: string }[];
  sortBy?: string;
  sortDesc: boolean;
  pageSize: number;
  /** Absent: every member, up to `ALL_MEMBERS_CAP`. */
  page?: number;
}

const MAX_FILTERS = 10;
const MAX_VALUE = 2_000;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;

/** What `query` without `page` returns at most, as it always has. */
export const ALL_MEMBERS_CAP = 500;

export function parseViewQuery(args: Record<string, unknown>): ViewQuery {
  const property = optionalSubject(args.property, 'property');
  const value = optionalString(args.value, 'value');
  const sortBy = optionalSubject(args.sortBy, 'sortBy');

  if (args.filters !== undefined && !Array.isArray(args.filters))
    throw new Error('filters must be a list of { property, value }');

  const rawFilters = (args.filters ?? []) as unknown[];

  if (rawFilters.length > MAX_FILTERS)
    throw new Error(`at most ${MAX_FILTERS} filters`);

  const filters = rawFilters.map(filter => {
    if (!filter || typeof filter !== 'object')
      throw new Error('a filter is { property, value }');
    const f = filter as Record<string, unknown>;

    return {
      property: optionalSubject(f.property, 'filter property') ?? missing(),
      value: optionalString(f.value, 'filter value') ?? missing(),
    };
  });

  // Without a constraint a query is the whole drive: a far bigger answer than
  // any view needs, and a slow one.
  if (!property && filters.length === 0)
    throw new Error('a query needs a property or a filter');

  const page = args.page;

  if (
    page !== undefined &&
    (!Number.isInteger(page) ||
      (page as number) < 0 ||
      (page as number) > MAX_PAGE)
  )
    throw new Error(`page must be a whole number from 0 to ${MAX_PAGE}`);

  const pageSize = args.pageSize ?? MAX_PAGE_SIZE;

  if (
    !Number.isInteger(pageSize) ||
    (pageSize as number) < 1 ||
    (pageSize as number) > MAX_PAGE_SIZE
  )
    throw new Error(`pageSize must be from 1 to ${MAX_PAGE_SIZE}`);

  return {
    property,
    value,
    filters,
    sortBy,
    sortDesc: args.sortDesc === true,
    pageSize: pageSize as number,
    page: page as number | undefined,
  };
}

/** The subjects matching `query`, one page or all of them (capped). */
export async function runViewQuery(
  store: Store,
  query: ViewQuery,
): Promise<string[]> {
  const builder = new CollectionBuilder(store).setFilters(query.filters);

  if (query.property) builder.setProperty(query.property);
  if (query.value !== undefined) builder.setValue(query.value);
  if (query.sortBy) builder.setSortBy(query.sortBy);
  builder.setSortDesc(query.sortDesc);

  if (query.page !== undefined) {
    return builder
      .setPageSize(query.pageSize)
      .build()
      .getMembersOnPage(query.page);
  }

  const all = await builder
    .setPageSize(ALL_MEMBERS_CAP)
    .build()
    .getAllMembers();

  return all.slice(0, ALL_MEMBERS_CAP);
}

function optionalSubject(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== 'string' || !Client.isValidSubject(value))
    throw new Error(`${name} must be a subject`);

  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== 'string' || value.length > MAX_VALUE)
    throw new Error(`${name} must be text of at most ${MAX_VALUE} characters`);

  return value;
}

function missing(): never {
  throw new Error('a filter needs a property and a value');
}
