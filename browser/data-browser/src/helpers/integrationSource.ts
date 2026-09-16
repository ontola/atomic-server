// @wc-ignore-file
/**
 * Fetches a bundled integration's `plugin.js` from the server's
 * `/integrations` static route (see server/build.rs::embed_integrations and
 * server/src/routes.rs), instead of inlining the source into this bundle at
 * build time via a Vite `?raw` import.
 */
const cache = new Map<string, Promise<string>>();

export function fetchIntegrationSource(id: string): Promise<string> {
  let promise = cache.get(id);

  if (!promise) {
    promise = fetch(`/integrations/${id}/plugin.js`).then(response => {
      if (!response.ok) {
        cache.delete(id);
        throw new Error(
          `Could not load the ${id} integration (${response.status}).`,
        );
      }

      return response.text();
    });
    cache.set(id, promise);
  }

  return promise;
}
