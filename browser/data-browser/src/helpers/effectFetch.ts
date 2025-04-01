export function effectFetch(
  url: string | URL,
  init?: Omit<RequestInit, 'signal'>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (callback: (json: any) => void, onError?: (e: Error) => void) => () => void {
  return (callback, onError) => {
    const controller = new AbortController();

    fetch(url, { ...init, signal: controller.signal })
      .then(r => r.json())
      .then(callback)
      .catch(e => {
        if (!controller.signal.aborted) {
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
