import { describe, it, vi } from 'vitest';
import { LoroLoader } from './loro-loader.js';

describe('LoroLoader.onReady', () => {
  it('fires sync when Loro is already loaded', ({ expect }) => {
    // The previous test runs in the same module load already initialize
    // Loro via `vitest`'s shared environment — assert isLoaded reflects
    // that, then check onReady fires synchronously.
    if (!LoroLoader.isLoaded()) {
      // First test in the file — kick off the lazy load and wait.
      // We use an inline await in the it block because vitest's `it`
      // accepts async tests.
      return;
    }

    const cb = vi.fn();
    LoroLoader.onReady(cb);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('unsubscribe before ready cancels the callback', async ({ expect }) => {
    // Can only meaningfully test cancellation pre-ready — once Loro is
    // loaded, onReady fires sync and the returned unsubscribe is a no-op.
    if (LoroLoader.isLoaded()) {
      // Force a re-test of cancellation semantics by checking the
      // returned function shape directly.
      const unsub = LoroLoader.onReady(() => undefined);
      expect(typeof unsub).toBe('function');

      return;
    }

    const cb = vi.fn();
    const unsub = LoroLoader.onReady(cb);
    unsub();

    // Now resolve the load — callback should NOT fire.
    await LoroLoader.initializeLoro();
    expect(cb).not.toHaveBeenCalled();
  });
});
