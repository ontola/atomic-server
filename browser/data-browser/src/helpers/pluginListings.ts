// @wc-ignore-file

/** One entry of `/plugin-catalog`: a public Listing resource on this server. */
export interface Listing {
  subject: string;
  name: string;
  emoji?: string | null;
  description: string;
  publisher?: string | null;
  domains: string[];
  standards: string[];
  /** The Release resource URL an Installation pins. */
  release: string;
  /** The `blake3:` id, which `/plugin-package/{id}` takes. */
  releaseId: string;
  runtime?: string | null;
  world?: string | null;
}

export function parsePluginListings(value: unknown): Listing[] {
  // Newer nodes include host capability metadata alongside their listings.
  // Keep accepting bare arrays from nodes that predate that envelope.
  const entries: unknown = Array.isArray(value)
    ? value
    : isRecord(value)
      ? value.entries
      : undefined;

  if (!Array.isArray(entries) || !entries.every(isListing)) {
    throw new Error('Invalid plugin catalog response');
  }

  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isListing(value: unknown): value is Listing {
  return (
    isRecord(value) &&
    ['subject', 'name', 'description', 'release', 'releaseId'].every(
      key => typeof value[key] === 'string',
    ) &&
    isStringArray(value.domains) &&
    isStringArray(value.standards) &&
    ['emoji', 'publisher', 'runtime', 'world'].every(
      key =>
        value[key] === undefined ||
        value[key] === null ||
        typeof value[key] === 'string',
    )
  );
}
