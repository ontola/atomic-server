// @wc-ignore-file
/** Adapt a trusted, deterministic synchronous plugin to asynchronous read capabilities.
 * Each invocation starts from the same input and replays receipts, never requests.
 * The caller must restrict `request` to declared reads; mutations are returned as
 * effects and executed separately after review. This does not evaluate graph code.
 */
export async function runWithAsyncReads<I, Request, Receipt, Result>(
  run: (input: I & { http: (request: Request) => Receipt }) => Result,
  input: I,
  request: (request: Request) => Promise<Receipt>,
  limit = 200,
): Promise<Result> {
  const receipts: { key: string; value: Receipt }[] = [];
  const suspended = {};
  for (;;) {
    let index = 0;
    let pending: Request | undefined;
    try {
      return run({
        ...(Object.fromEntries(
          Object.entries(input as object).map(([key, value]) => [
            key,
            typeof value === 'function' ? value : structuredClone(value),
          ]),
        ) as I),
        http: (next: Request) => {
          const key = JSON.stringify(next);
          const previous = receipts[index++];
          if (previous) {
            if (previous.key !== key)
              throw new Error('Plugin reads changed while replaying receipts');
            return structuredClone(previous.value);
          }
          pending = next;
          throw suspended;
        },
      });
    } catch (error) {
      if (error !== suspended) throw error;
      if (receipts.length >= limit)
        throw new Error('Plugin exceeded its request limit');
      const next = pending as Request;
      receipts.push({ key: JSON.stringify(next), value: await request(next) });
    }
  }
}
