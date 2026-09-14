/** Bundled lens setup stays discoverable even when the remote catalog is unavailable. */
export function localThoughtCatalogEntries(platforms: string[] = []): string[] {
  return [...new Set(['google-calendar', ...platforms])];
}
