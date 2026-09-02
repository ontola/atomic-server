/**
 * Resolve to `fallback` if `work` has not finished within `ms`.
 *
 * For the places where a slow answer and no answer are the same thing to the
 * user, and where the caller already has a correct behaviour for "could not
 * find out". Signing in is the motivating case: it asks a server which drive
 * belongs to this agent, and a device that just restored a secret may have no
 * server that knows — the embedded node in the desktop and Android apps
 * answers, but not about an account it has never seen. Those fetches have no
 * timeout of their own, so the await never settled and sign-in sat on
 * "Restoring…" indefinitely, on exactly the device that had nothing.
 *
 * Deliberately not a cancellation: `work` keeps running and its result is
 * discarded. Rejections are swallowed for the same reason — once we have
 * stopped waiting, a late failure is not the caller's problem and must not
 * surface as an unhandled rejection.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);

    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
