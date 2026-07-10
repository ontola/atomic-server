import { useEffect } from 'react';

/**
 * Publishes the on-screen keyboard's height as the `--keyboard-inset` CSS
 * variable (`0px` when there's no keyboard).
 *
 * The obvious signal doesn't work. Android's `windowSoftInputMode="adjustResize"`
 * is set, but our webview draws edge-to-edge (`viewport-fit=cover`), and an
 * edge-to-edge window is not resized for the keyboard — it's covered by it. So
 * `window.innerHeight`, and therefore `100dvh`, stays at the full screen height
 * while the bottom third of the layout sits under the keyboard. Measured on a
 * Xiaomi 15: `innerHeight` 731 both before and after, while
 * `visualViewport.height` went 731 → 457.
 *
 * The visual viewport is the only thing that reacts, so read that instead.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;

    if (!viewport) {
      return;
    }

    const root = document.documentElement;

    const update = () => {
      // Pinch-zoom also shrinks the visual viewport. That's the user looking
      // closer, not a keyboard — don't reserve space for it.
      const covered =
        viewport.scale > 1
          ? 0
          : window.innerHeight - viewport.height - viewport.offsetTop;

      root.style.setProperty(
        '--keyboard-inset',
        `${Math.max(0, Math.round(covered))}px`,
      );
    };

    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);

    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);
}
