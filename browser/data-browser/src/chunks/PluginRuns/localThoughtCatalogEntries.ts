/** Generated catalogs contain only provider-published integrations. */
export function localThoughtCatalogEntries(platforms: string[] = []): string[] {
  return [...new Set(platforms)];
}
