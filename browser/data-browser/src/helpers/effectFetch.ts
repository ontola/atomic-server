import { pageRequestSignal } from '@tomic/lib';

export function effectFetch(
  url: string | URL,
  init?: Omit<RequestInit, 'signal'>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (callback: (json: any) => void, onError?: (e: Error) => void) => () => void {
  return (callback, onError) => {
    const controller = new AbortController();
    // A navigation cancels every request the old document still has in flight,
    // and `fetch` reports that as a plain `TypeError: Failed to fetch` — the
    // same rejection an unreachable server produces. Our own controller is NOT
    // aborted in that case, so the check below used to let the cancellation
    // through as a genuine error: `OllamaModelSelector` rendered "Unable to
    // connect to Ollama server" and `console.error`d on a server that had
    // answered fine a moment earlier. Measured on `ollama-feedback.spec.ts`
    // (the test reloads the settings page mid-test): 5 of 8 runs logged it, and
    // in every one of those the request failed with `net::ERR_ABORTED` between
    // the reload starting and finishing, never outside that window.
    //
    // `pageRequestSignal()` aborts on a non-persisted `pagehide`, which is the
    // document being discarded, so it tells the two apart. `client.ts` and
    // `loro-loader.ts` already read it for the same reason.
    const pageSignal = pageRequestSignal();

    fetch(url, { ...init, signal: controller.signal })
      .then(r => r.json())
      .then(callback)
      .catch(e => {
        if (!controller.signal.aborted && !pageSignal?.aborted) {
          if (onError) {
            onError(e);
          } else {
            throw e;
          }
        }
      });

    return () => controller.abort();
  };
}
