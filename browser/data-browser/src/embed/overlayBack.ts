// @wc-ignore-file
/**
 * Full-screen overlays of the embed (the meeting chat) register here while they
 * are open, so the host's Back button (`atomicEmbed.back()`) dismisses the
 * topmost one before the page itself goes back.
 */
const closers: Array<() => void> = [];

/** Registers an open overlay; returns the function that unregisters it. */
export function registerOverlay(close: () => void): () => void {
  closers.push(close);

  return () => {
    const index = closers.lastIndexOf(close);

    if (index >= 0) closers.splice(index, 1);
  };
}

/** Closes the topmost overlay. False when none is open. */
export function closeTopOverlay(): boolean {
  const close = closers.pop();

  if (!close) return false;

  close();

  return true;
}

const navigationListeners = new Set<() => void>();

/** Runs when the host moves the page to another resource. */
export function onHostNavigate(listener: () => void): () => void {
  navigationListeners.add(listener);

  return () => {
    navigationListeners.delete(listener);
  };
}

/**
 * The host opened or showed a resource: no overlay (or the panel behind it)
 * of the previous one stays, so a reused page never starts with a chat open.
 */
export function closeAllOverlays(): void {
  while (closeTopOverlay()) {
    // closeTopOverlay pops each one.
  }

  for (const listener of [...navigationListeners]) listener();
}
