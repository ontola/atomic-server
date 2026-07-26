/**
 * The Drive this server serves as its front page, if the operator configured
 * one (`ATOMIC_HOME_DRIVE`).
 *
 * The server writes this into the HTML it serves, so it is readable
 * synchronously on the very first render — before the JS bundle would have had
 * time to ask the server anything. That matters: routing `/` cannot wait. The
 * Agent lives in IndexedDB, which has no synchronous API, so "is anyone signed
 * in?" is only knowable after an async read. A configured home Drive sidesteps
 * that entirely, because it is shown to everyone regardless of sign-in state.
 *
 * Unset on most servers. Then `/` keeps its default behaviour: visitors without
 * an Agent go to the welcome / sign-in flow, which is correct for a
 * multi-tenant server whose root is not a public Drive.
 */
// Read off `globalThis` rather than `window`: the injected script assigns to
// `window`, which IS `globalThis` in a browser, and this way the helper also
// works in workers and under a non-DOM test runner.
export function getHomeDrive(): string | undefined {
  const value = (globalThis as { __ATOMIC_HOME_DRIVE__?: unknown })
    .__ATOMIC_HOME_DRIVE__;

  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}
