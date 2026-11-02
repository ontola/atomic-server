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
 * Reads the body of `/plugin-catalog`: older nodes return a bare array, while
 * newer nodes wrap it in `entries` alongside host capability metadata. Only
 * the listings are needed here. A node or proxy can also answer 200 with an
 * unrelated JSON body; throw so the page shows the problem without crashing.
 */
export function parseListings(body: unknown): Listing[] {
  const entries: unknown = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && 'entries' in body
      ? body.entries
      : undefined;

  if (!Array.isArray(entries)) {
    throw new Error('The plugin catalog did not return a list of plugins.');
  }

  return entries
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
