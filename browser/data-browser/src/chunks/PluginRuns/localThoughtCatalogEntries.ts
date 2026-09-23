/** Generated catalogs contain only provider-published integrations, in the
 * provider's order. Which of them get a card is up to the plugin catalog
 * entry that describes each platform (see `catalogByPlatform`). */
export function localThoughtCatalogEntries(platforms: string[] = []): string[] {
  return [...new Set(platforms)];
}
