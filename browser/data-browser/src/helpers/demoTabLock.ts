// One demo per browser, however many tabs. Starting the demo cleans up every
// earlier demo drive, so a second tab opening /app/demo used to delete the
// workspace the first tab was in the middle of. The tab whose director runs
// the scene holds this lock; another tab that finds it held joins that demo
// instead of building a new one.

const LOCK = 'atomic-demo-director';

let release: (() => void) | undefined;

/** Called by the tab that starts the director. Idempotent. */
export function holdDemoLock(): void {
  if (release || typeof navigator === 'undefined' || !navigator.locks) return;

  void navigator.locks.request(
    LOCK,
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  );
}

/** Called when this tab's director stops (leaving or replacing the demo). */
export function releaseDemoLock(): void {
  release?.();
  release = undefined;
}

/** Whether a director runs in another tab of this browser right now. */
export async function demoRunningInAnotherTab(): Promise<boolean> {
  if (release || typeof navigator === 'undefined' || !navigator.locks?.query)
    return false;

  try {
    const { held = [] } = await navigator.locks.query();

    return held.some(lock => lock.name === LOCK);
  } catch {
    return false;
  }
}
