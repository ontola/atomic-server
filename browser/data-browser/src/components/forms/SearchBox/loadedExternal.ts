import { core, type Resource } from '@tomic/react';

/** Built-in ontology origins. The server search already covers these. */
const BUILT_IN_ORIGINS = ['https://atomicdata.dev'];

function originOf(subject: string): string | undefined {
  try {
    return new URL(subject).origin;
  } catch {
    return undefined;
  }
}

/**
 * The origin of a subject that lives outside the user's server, like a shared
 * class on `https://ontola.github.io/atomic-plugins/ontology/...`. Undefined
 * for DIDs, the server's own subjects and the built-in ontologies, which the
 * server search already finds.
 */
export function externalOrigin(
  subject: string,
  serverUrl: string,
): string | undefined {
  if (!subject.startsWith('http://') && !subject.startsWith('https://')) {
    return undefined;
  }

  const origin = originOf(subject);

  if (
    !origin ||
    origin === originOf(serverUrl) ||
    BUILT_IN_ORIGINS.includes(origin)
  ) {
    return undefined;
  }

  return origin;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * Finds external resources of class `isA` that the store has already fetched,
 * matching `query` on their shortname, name and description. The server's
 * full-text search never sees these, because they live outside the drive.
 * Matches on shortname or name come before matches on the description.
 *
 * Takes the store's map rather than an iterator: the React Compiler may cache
 * an argument expression, and a cached iterator is empty the second time.
 */
export function searchLoadedExternal(
  resources: ReadonlyMap<string, Resource>,
  query: string,
  isA: string,
  serverUrl: string,
): string[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return [];
  }

  const titleMatches: string[] = [];
  const descriptionMatches: string[] = [];

  for (const resource of resources.values()) {
    if (
      !resource.isReady() ||
      !externalOrigin(resource.subject, serverUrl) ||
      !resource.hasClasses(isA)
    ) {
      continue;
    }

    const shortname = asText(resource.get(core.properties.shortname));
    const name = asText(resource.get(core.properties.name));
    const description = asText(resource.get(core.properties.description));

    if (shortname.includes(needle) || name.includes(needle)) {
      titleMatches.push(resource.subject);
    } else if (description.includes(needle)) {
      descriptionMatches.push(resource.subject);
    }
  }

  return [...titleMatches, ...descriptionMatches];
}
