/**
 * Port of `flutter/lib/canvas/fan_helpers.dart`. Pen-colour fan: 8 hues ×
 * 4 distance rings = 32 swatches, plus a 4-step greyscale ramp as the
 * last hue column. Width fan: 7 widths arranged on a single semicircle.
 * Geometry is identical to Flutter so the two clients render the same
 * fan at the same pixel positions.
 */

/** Stroke widths, smallest → largest, in canvas pixels at scale=1. */
export const FAN_WIDTHS = [1, 2, 5, 10, 18, 30, 46];

/** Number of hue columns (last one is greyscale). */
export const FAN_HUES = 8;
/** Number of distance rings, innermost → outermost. */
export const FAN_DISTS = 4;

/**
 * Minimum drag distance from the button centre before any swatch is
 * considered hovered. Inside this radius the gesture is "centre / no
 * selection" — same as Flutter's `dragOffset.distance < 40 * scale`.
 */
export const FAN_DEAD_ZONE_PX = 40;

/** Innermost fan ring radius from the button centre, in pixels. */
export const FAN_BASE_RADIUS = 80;
/** Distance between successive fan rings, in pixels. */
export const FAN_DIST_STEP = 50;

/** Width-fan radius from the button centre, in pixels. */
export const FAN_WIDTH_RADIUS = 100;

/**
 * Compute the colour at a given `(hueIndex, distIndex)` fan position,
 * matching Flutter's `getFanColor`. Returns a CSS `rgb(r,g,b)` string.
 *
 * - `hueIndex == FAN_HUES - 1` is the greyscale column.
 * - Otherwise hues sweep from 0° to 300° across the other 7 columns.
 * - Distance index selects between four (saturation, value) pairs:
 *   pastel → normal → dark → very dark.
 */
export function fanColor(hueIndex: number, distIndex: number): string {
  if (hueIndex === FAN_HUES - 1) {
    const v = [0.9, 0.6, 0.3, 0.0][distIndex] ?? 0;
    const c = Math.round(v * 255);

    return `rgb(${c}, ${c}, ${c})`;
  }

  const hue = (hueIndex / (FAN_HUES - 2)) * 300;
  const sv: [number, number] = (
    [
      [0.4, 1.0],
      [0.8, 0.9],
      [0.9, 0.6],
      [1.0, 0.3],
    ] as Array<[number, number]>
  )[distIndex] ?? [0.5, 0.5];

  const { r, g, b } = hsvToRgb(hue, sv[0], sv[1]);

  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Same colour as {@link fanColor} but packed as the `0xAARRGGBB` integer
 * the canvas stores in `strokeData`. Keeps the wire format identical to
 * Flutter's `Color.value` so a stroke drawn from either client renders
 * the same on the other.
 */
export function fanColorInt(hueIndex: number, distIndex: number): number {
  if (hueIndex === FAN_HUES - 1) {
    const v = [0.9, 0.6, 0.3, 0.0][distIndex] ?? 0;
    const c = Math.round(v * 255);

    return (0xff << 24) | (c << 16) | (c << 8) | c;
  }

  const hue = (hueIndex / (FAN_HUES - 2)) * 300;
  const sv: [number, number] = (
    [
      [0.4, 1.0],
      [0.8, 0.9],
      [0.9, 0.6],
      [1.0, 0.3],
    ] as Array<[number, number]>
  )[distIndex] ?? [0.5, 0.5];

  const { r, g, b } = hsvToRgb(hue, sv[0], sv[1]);

  // `>>> 0` coerces back to unsigned 32-bit so the result is the same
  // number Flutter writes to `strokeData.color`.
  return ((0xff << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

/** Screen-coordinate centre of a `(hueIndex, distIndex)` colour swatch. */
export function fanColorCenter(
  hueIndex: number,
  distIndex: number,
): { x: number; y: number } {
  const r = FAN_BASE_RADIUS + distIndex * FAN_DIST_STEP;
  const angle = (-180 + hueIndex * (180 / (FAN_HUES - 1))) * (Math.PI / 180);

  return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
}

/** Screen-coordinate centre of width index `i` on the width fan. */
export function fanWidthCenter(i: number): { x: number; y: number } {
  const angle = (-180 + i * (180 / (FAN_WIDTHS.length - 1))) * (Math.PI / 180);

  return {
    x: FAN_WIDTH_RADIUS * Math.cos(angle),
    y: FAN_WIDTH_RADIUS * Math.sin(angle),
  };
}

/**
 * Resolve the colour the user is currently dragging toward. `dragOffset`
 * is the cursor position relative to the button centre (`cursor - centre`).
 * Returns `null` inside the dead zone (no selection).
 */
export function hoveredColor(dragOffset: {
  x: number;
  y: number;
}): { color: number; hueIndex: number; distIndex: number } | null {
  if (Math.hypot(dragOffset.x, dragOffset.y) < FAN_DEAD_ZONE_PX) {
    return null;
  }

  let closest = Infinity;
  let best: { color: number; hueIndex: number; distIndex: number } | null =
    null;

  for (let d = 0; d < FAN_DISTS; d++) {
    for (let h = 0; h < FAN_HUES; h++) {
      const { x, y } = fanColorCenter(h, d);
      const dist = Math.hypot(x - dragOffset.x, y - dragOffset.y);
      if (dist < closest) {
        closest = dist;
        best = { color: fanColorInt(h, d), hueIndex: h, distIndex: d };
      }
    }
  }

  return best;
}

/** Resolve the width the user is dragging toward. `null` inside dead zone. */
export function hoveredWidth(dragOffset: {
  x: number;
  y: number;
}): number | null {
  if (Math.hypot(dragOffset.x, dragOffset.y) < FAN_DEAD_ZONE_PX) {
    return null;
  }

  let closest = Infinity;
  let best: number | null = null;

  for (let i = 0; i < FAN_WIDTHS.length; i++) {
    const { x, y } = fanWidthCenter(i);
    const dist = Math.hypot(x - dragOffset.x, y - dragOffset.y);
    if (dist < closest) {
      closest = dist;
      best = FAN_WIDTHS[i];
    }
  }

  return best;
}

/** Convert HSV (0-360, 0-1, 0-1) to 8-bit RGB. */
function hsvToRgb(
  h: number,
  s: number,
  v: number,
): { r: number; g: number; b: number } {
  const c = v * s;
  const hh = (h % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hh < 1) {
    r1 = c;
    g1 = x;
  } else if (hh < 2) {
    r1 = x;
    g1 = c;
  } else if (hh < 3) {
    g1 = c;
    b1 = x;
  } else if (hh < 4) {
    g1 = x;
    b1 = c;
  } else if (hh < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const m = v - c;

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}
