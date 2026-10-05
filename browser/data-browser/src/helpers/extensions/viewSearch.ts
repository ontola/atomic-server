// @wc-ignore-file
import { Client, core, type Store } from '@tomic/react';

/** A full-text search a view may run: `store.search` with bounded options. */
export interface ViewSearch {
  text: string;
  isA?: string;
  parents: string[];
  limit: number;
}

const MAX_TEXT = 500;
const MAX_LIMIT = 50;
const MAX_PARENTS = 10;

export function parseViewSearch(args: Record<string, unknown>): ViewSearch {
  const { text, isA, parents = [], limit = 20 } = args;

  if (typeof text !== 'string' || text.length > MAX_TEXT)
    throw new Error(`text must be at most ${MAX_TEXT} characters`);

  if (
    isA !== undefined &&
    (typeof isA !== 'string' || !Client.isValidSubject(isA))
  )
    throw new Error('isA must be a class subject');

  if (
    !Array.isArray(parents) ||
    parents.length > MAX_PARENTS ||
    !parents.every(p => typeof p === 'string' && Client.isValidSubject(p))
  )
    throw new Error(`parents must be at most ${MAX_PARENTS} subjects`);

  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_LIMIT
  )
    throw new Error(`limit must be from 1 to ${MAX_LIMIT}`);

  return {
    text,
    isA: isA as string | undefined,
    parents: parents as string[],
    limit: limit as number,
  };
}

/** Subjects matching the search, as the signed-in person would find them. */
export async function runViewSearch(
  store: Store,
  search: ViewSearch,
): Promise<string[]> {
  return store.search(search.text, {
    limit: search.limit,
    ...(search.parents.length ? { parents: search.parents } : {}),
    ...(search.isA ? { filters: { [core.properties.isA]: search.isA } } : {}),
  });
}
