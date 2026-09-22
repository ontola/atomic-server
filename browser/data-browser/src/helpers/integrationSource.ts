// @wc-ignore-file
/** Fetch a bundled plugin from the connected server, including in desktop builds. */
const cache = new Map<string, Promise<string>>();

export function fetchIntegrationSource(
  id: string,
  server: string,
): Promise<string> {
  const url = new URL(`/integrations/${id}/plugin.js`, server).href;
  let promise = cache.get(url);

  if (!promise) {
    promise = fetch(url)
      .then(response => {
        if (!response.ok) {
          throw new Error(
            `Could not load the ${id} integration (${response.status}).`,
          );
        }

        return response.text();
      })
      .catch(reason => {
        cache.delete(url);
        throw reason;
      });
    cache.set(url, promise);
  }

  return promise;
}
