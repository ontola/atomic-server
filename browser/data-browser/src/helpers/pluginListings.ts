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
 * Reads `/plugin-catalog` as a legacy array or an envelope with `entries` and
 * optional host metadata. Only the entries reach the existing normalizer.
 * Unrelated JSON still throws so the page can show its catalog error card.
 */
export function parseListings(body: unknown): Listing[] {
  const entries: unknown = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && 'entries' in body
      ? body.entries
      : undefined;

  if (!Array.isArray(entries)) {
    throw new Error('The app catalog did not return a list of apps.');
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
