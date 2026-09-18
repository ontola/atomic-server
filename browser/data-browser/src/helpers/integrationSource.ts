// @wc-ignore-file
/**
 * Fetches a bundled integration's `plugin.js` from the server's
 * `/integrations` static route (see server/build.rs::embed_integrations and
 * server/src/routes.rs), instead of inlining the source into this bundle at
 * build time via a Vite `?raw` import.
 *
 * `server` is the store's server URL, not the frontend's own origin: the
 * vite dev server and a Tauri build serve the SPA from somewhere else, and
 * their origin answers this path with index.html rather than a 404.
 */
const cache = new Map<string, Promise<string>>();

export function fetchIntegrationSource(
  server: string,
  id: string,
): Promise<string> {
  const key = `${server}/integrations/${id}/plugin.js`;
  let promise = cache.get(key);

  if (!promise) {
    promise = fetch(key).then(response => {
      if (!response.ok) {
        cache.delete(key);
        throw new Error(
          `Could not load the ${id} integration (${response.status}).`,
        );
      }

      return response.text();
    });
    cache.set(key, promise);
  }

  return promise;
}
