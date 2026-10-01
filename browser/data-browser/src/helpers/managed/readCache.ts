/** Share brief bursts of account metadata reads. Nothing is persisted. */
export class ManagedReadCache {
  private entries = new Map<
    string,
    {
      response: Promise<Response>;
      expires: number;
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

    // Signals belong to individual callers. Requests with special fetch
    // semantics bypass sharing rather than changing another caller's read.
    if (
      method !== 'GET' ||
      init.signal ||
      init.cache ||
      !/\/api\/(me|sync-enrollments|recovery-secret)$/.test(url)
    ) {
      return fetch(url, init);
    }

    for (const [key, entry] of this.entries) {
      if (entry.expires <= Date.now()) this.entries.delete(key);
    }

    const key = JSON.stringify([
      url,
      init.credentials,
      [...new Headers(init.headers).entries()].sort(),
    ]);
    const existing = this.entries.get(key);

    if (existing && existing.expires > Date.now()) {
      return (await existing.response).clone();
    }

    const entry = { response: fetch(url, init), expires: Date.now() + 5000 };
    this.entries.set(key, entry);

    try {
      const response = await entry.response;

      // Anonymous, missing and failed reads must be retryable immediately.
      if (response.status !== 200 && this.entries.get(key) === entry) {
        this.entries.delete(key);
      }

      return response.clone();
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }
}
