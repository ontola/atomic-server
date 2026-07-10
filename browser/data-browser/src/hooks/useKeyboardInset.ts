import { useEffect } from 'react';

/**
 * Publishes the on-screen keyboard's height as the `--keyboard-inset` CSS
 * variable (`0px` when there's no keyboard), so layouts can subtract it and
 * shrink instead of being covered.
 *
 * Neither obvious signal works. Android's `windowSoftInputMode="adjustResize"`
 * is set, but our webview draws edge-to-edge (`viewport-fit=cover`), and an
 * edge-to-edge window is not resized for the keyboard — it's covered by it. And
 * `interactive-widget=resizes-content` in the viewport meta, which is supposed
 * to shrink the layout viewport, is ignored by the Android WebView (measured).
 * So `window.innerHeight`, and therefore `100dvh`, stays at the full screen
 * height. Measured on a Xiaomi 15: `innerHeight` 731 both before and after,
 * while `visualViewport.height` went 731 → 457.
 *
 * Left uncorrected, the browser reveals a focused field by scrolling the
 * *visual* viewport over the too-tall layout — which drags `position: fixed`
 * chrome (the top bar) off the top of the screen. Shrinking the layout means
 * there is nothing to scroll and the top bar stays put.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;

    if (!viewport) {
      return;
    }

    const root = document.documentElement;

    const update = () => {
      // The keyboard's height is what the layout viewport has that the visual
      // one doesn't. `offsetTop` is orthogonal — it's how far the visual
      // viewport has been scrolled, which is the symptom we're removing, not
      // part of the measurement.
      //
      // Pinch-zoom also shrinks the visual viewport. That's the user looking
      // closer, not a keyboard — don't reserve space for it.
      const covered =
        viewport.scale > 1 ? 0 : window.innerHeight - viewport.height;

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
