import type { CanvasStroke } from '@tomic/lib';
import { adjustStrokeColorForDarkMode } from '@tomic/lib';
import {
  TEXT_FONT_FAMILY,
  TEXT_LINE_HEIGHT,
  type Bounds,
} from './canvas-elements';

const imageCache = new Map<string, HTMLImageElement>();
const imageListeners = new Set<() => void>();

/** Called when an image element finishes decoding, so the canvas repaints. */
export function onCanvasImageLoaded(listener: () => void): () => void {
  imageListeners.add(listener);

  return () => imageListeners.delete(listener);
}

function cachedImage(src: string): HTMLImageElement | undefined {
  let img = imageCache.get(src);

  if (!img) {
    img = new Image();
    img.onload = () => imageListeners.forEach(l => l());
    img.src = src;
    imageCache.set(src, img);
  }

  return img.complete && img.naturalWidth > 0 ? img : undefined;
}

/** Draw all strokes with pan/zoom transform (matches Flutter CanvasPainter). */
export function drawCanvasStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: CanvasStroke[],
  currentStroke: CanvasStroke | null,
  scale: number,
  offsetX: number,
  offsetY: number,
  darkMode: boolean,
): void {
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  for (const stroke of strokes) {
    drawStroke(ctx, stroke, darkMode);
  }

  if (currentStroke) {
    drawStroke(ctx, currentStroke, darkMode);
  }

  ctx.restore();
}

function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: CanvasStroke,
  darkMode: boolean,
): void {
  if (stroke.path.length === 0) {
    return;
  }

  if (stroke.kind === 'text') {
    drawText(ctx, stroke, darkMode);

    return;
  }

  if (stroke.kind === 'image') {
    const img = stroke.src ? cachedImage(stroke.src) : undefined;
    const [x, y] = stroke.path[0];

    if (img) {
      ctx.drawImage(img, x, y, stroke.w ?? img.width, stroke.h ?? img.height);
    } else {
      ctx.fillStyle = 'rgba(128,128,128,0.25)';
      ctx.fillRect(x, y, stroke.w ?? 0, stroke.h ?? 0);
    }

    return;
  }

  ctx.strokeStyle = adjustStrokeColorForDarkMode(stroke.color, darkMode);
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.path.length === 1) {
    const [x, y] = stroke.path[0];
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(x, y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();

    return;
  }

  const path = new Path2D();
  const [x0, y0] = stroke.path[0];
  path.moveTo(x0, y0);

  for (let i = 1; i < stroke.path.length; i++) {
    const [px, py] = stroke.path[i - 1];
    const [cx, cy] = stroke.path[i];
    path.quadraticCurveTo(px, py, (px + cx) / 2, (py + cy) / 2);
  }

  ctx.stroke(path);
}

function drawText(
  ctx: CanvasRenderingContext2D,
  el: CanvasStroke,
  darkMode: boolean,
): void {
  const size = el.size ?? 24;
  const [x, y] = el.path[0];

  ctx.fillStyle = adjustStrokeColorForDarkMode(el.color, darkMode);
  ctx.font = `${size}px ${TEXT_FONT_FAMILY}`;
  ctx.textBaseline = 'top';

  (el.text ?? '').split('\n').forEach((line, i) => {
    ctx.fillText(line, x, y + i * size * TEXT_LINE_HEIGHT + size * 0.1);
  });
}

export const HANDLE_RADIUS = 9;

/** Lasso loop and selection box, painted in screen space on top. */
export function drawSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  lasso: [number, number][] | null,
  selected: Bounds | null,
  scale: number,
  offsetX: number,
  offsetY: number,
  accent: string,
): void {
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);

  if (lasso && lasso.length > 1) {
    ctx.beginPath();
    lasso.forEach(([x, y], i) => {
      const sx = x * scale + offsetX;
      const sy = y * scale + offsetY;

      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
  }

  if (selected) {
    const x0 = selected.minX * scale + offsetX;
    const y0 = selected.minY * scale + offsetY;
    const x1 = selected.maxX * scale + offsetX;
    const y1 = selected.maxY * scale + offsetY;

    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';

    for (const [hx, hy] of [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ]) {
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.restore();
}

/** Screen position → canvas coordinates. */
export function screenToCanvas(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  scale: number,
  offsetX: number,
  offsetY: number,
): [number, number] {
  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;

  return [x, y];
}
