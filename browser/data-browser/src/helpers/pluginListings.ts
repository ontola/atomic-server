// @wc-ignore-file

/** One entry of `/plugin-catalog`: a public Listing resource on this server. */
export interface Listing {
  subject: string;
  name: string;
  emoji: string | null;
  description: string;
  publisher: string | null;
  domains: string[];
  standards: string[];
  /** The Release resource URL an Installation pins. */
  release: string;
  /** The `blake3:` id, which `/plugin-package/{id}` takes. */
  releaseId: string;
  runtime: string | null;
  world: string | null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Reads the body of `/plugin-catalog`, which is untrusted: a node that has no
 * such route (older, or built without plugin routes) or a proxy in front of
 * one can answer 200 with JSON that is not a list, and the page filters it.
 * Throws so the page shows the problem instead of crashing.
 */
export function parseListings(body: unknown): Listing[] {
  if (!Array.isArray(body)) {
    throw new Error('The plugin catalog did not return a list of plugins.');
  }

  return body
    .filter(
      (entry): entry is Listing => typeof entry === 'object' && entry !== null,
    )
    .map(entry => ({
      ...entry,
      name: String(entry.name ?? ''),
      description: String(entry.description ?? ''),
      domains: strings(entry.domains),
      standards: strings(entry.standards),
    }));
}
