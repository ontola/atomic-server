/** Generated catalogs contain only provider-published integrations. A
 * platform that a bundled catalog entry already connects through (its
 * `platform` field) is left out, so it is offered once, with its card copy,
 * rather than again as a raw proxy card. */
export function localThoughtCatalogEntries(
  platforms: string[] = [],
  bundledPlatforms: Iterable<string> = [],
): string[] {
  const claimed = new Set(bundledPlatforms);

  return [...new Set(platforms)].filter(id => !claimed.has(id));
}
