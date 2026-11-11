/** Share brief bursts of account metadata reads. Nothing is persisted. */
export class ManagedReadCache {
  /** Metadata reads, shared while in flight and for 5 s after a 200. */
  private entries = new Map<
    string,
    {
      response: Promise<Response>;
      /** Undefined while in flight. */
      expires?: number;
    }
  >();

  invalidate(): void {
    this.entries.clear();
  }

  async fetch(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();

    if (method !== 'GET' && method !== 'HEAD') {
      // Background vault transfers, catalog reports and device heartbeats do
      // not change identity, recovery wrappers or Cloud Server enrollments.
      // Invalidating on them turns every backup into another metadata burst.
      if (/\/api\/(cloud-vault|drives\/catalog|devices|ai)(?:\/|$)/.test(url)) {
        return fetch(url, init);
      }

      // Reads that race a mutation must not populate the next read's cache.
      this.invalidate();

      try {
        return await fetch(url, init);
      } finally {
        this.invalidate();
      }
    }

    const metadata = /\/api\/(me|sync-enrollments|recovery-secret)$/.test(url);

    // Signals belong to individual callers.
    if (method !== 'GET' || init.signal || !metadata) {
      return fetch(url, init);
    }

    for (const [key, entry] of this.entries) {
      if (entry.expires !== undefined && entry.expires <= Date.now())
        this.entries.delete(key);
    }

    // The cache mode is left out of the key: callers asking at the same
    // moment are one question, whichever of them asked for a refresh.
    const key = JSON.stringify([
      url,
      init.credentials,
      [...new Headers(init.headers).entries()].sort(),
    ]);
    const existing = this.entries.get(key);

    // An explicit refresh (`cache` set) joins a request in flight, but never
    // reads an answer an earlier call left behind.
    if (existing && (existing.expires === undefined || !init.cache)) {
      return (await existing.response).clone();
    }

    const entry: { response: Promise<Response>; expires?: number } = {
      response: fetch(url, init),
    };
    this.entries.set(key, entry);

    try {
      const response = await entry.response;

      if (this.entries.get(key) === entry) {
        // Anonymous, missing and failed reads must be retryable immediately.
        if (response.status === 200) entry.expires = Date.now() + 5000;
        else this.entries.delete(key);
      }

      return response.clone();
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }
}
