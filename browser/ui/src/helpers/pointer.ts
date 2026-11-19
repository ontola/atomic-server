/**
 * Whether the primary pointing device is touch, i.e. a phone or a tablet.
 *
 * Use this rather than a viewport width breakpoint when the question is "is
 * this thumb-operated": a landscape tablet is as wide as a laptop, and a
 * desktop window dragged narrow is still mouse-operated. A touchscreen laptop
 * reports a fine primary pointer, so it counts as desktop here.
 */
export function isTouchPrimary(): boolean {
  if (!window.matchMedia) {
    return false;
  }

  return window.matchMedia('(pointer: coarse)').matches;
}
