import type { CanvasStroke } from '@tomic/lib';
import { adjustStrokeColorForDarkMode } from '@tomic/lib';

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
