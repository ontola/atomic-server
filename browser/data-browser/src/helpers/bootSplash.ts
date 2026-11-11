// The boot splash in index.html: the orbiting mark on an empty page. It sits
// outside #root, so it stays until something here says the page is ready.
//
// Pages drop it once the app has shown no loader of its own for a moment (see
// index.tsx), so the one splash covers the whole wait.

const SPLASH_ID = 'boot-splash';
const LEAVING = 'boot-splash-leaving';

function splash(): HTMLElement | null {
  return typeof document === 'undefined'
    ? null
    : document.getElementById(SPLASH_ID);
}

/** Whether the boot splash covers the page. */
function isBootSplashVisible(): boolean {
  const element = splash();

  return !!element && !element.classList.contains(LEAVING);
}

/** Fade the splash out. Idempotent. */
function hideBootSplash(): void {
  splash()?.classList.add(LEAVING);
}

let holds = 0;
let lastBusyAt = 0;
let settleTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Keep the splash up while something in the app shows its own loader (a
 * pane-level `<Spinner centered />`). Returns the release.
 */
export function holdBootSplash(): () => void {
  holds += 1;
  lastBusyAt = Date.now();
  let released = false;

  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    lastBusyAt = Date.now();
  };
}

/**
 * Hide the splash once the app has shown no loader of its own for `quietMs`,
 * or after `maxMs` whatever happens. The splash is the one loader from the
 * first paint to the first real content, so nothing moves in between; the
 * quiet gap bridges one loader replacing another.
 */
export function hideBootSplashWhenSettled({
  quietMs = 100,
  maxMs = 8_000,
} = {}): void {
  if (settleTimer) return;
  const startedAt = Date.now();
  lastBusyAt = Math.max(lastBusyAt, startedAt);

  settleTimer = setInterval(() => {
    const now = Date.now();
    const settled = holds === 0 && now - lastBusyAt >= quietMs;

    if (!settled && now - startedAt < maxMs && isBootSplashVisible()) return;

    clearInterval(settleTimer);
    settleTimer = undefined;
    hideBootSplash();
  }, 25);
}

/** Two frames: long enough for React to have committed and the browser to
 *  have painted what it committed. */
export function afterNextPaint(): Promise<void> {
  return new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}
