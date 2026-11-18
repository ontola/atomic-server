export interface ResizeImageOptions {
  /** Longest dimension of the output, in pixels. */
  maxSize: number;
  /** Center-crop to a square before scaling. */
  square?: boolean;
  /** Encoder quality, 0–1. */
  quality?: number;
  /**
   * Source rectangle to crop from (in source-image pixels), e.g. from an
   * interactive cropper. Applied instead of the automatic square crop.
   */
  sourceRect?: { x: number; y: number; width: number; height: number };
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
}

/**
 * Decodes an image file for canvas drawing. `createImageBitmap` is the fast
 * path, but it rejects on some real-world files (CMYK JPEGs, unusual ICC
 * profiles) that an <img> element decodes fine — so fall back to that.
 */
async function decodeImage(file: File): Promise<DecodedImage> {
  try {
    const bitmap = await createImageBitmap(file);

    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    };
  } catch (_e) {
    const url = URL.createObjectURL(file);

    try {
      const img = new Image();
      img.src = url;
      await img.decode();

      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        cleanup: () => URL.revokeObjectURL(url),
      };
    } catch (_e2) {
      URL.revokeObjectURL(url);
      throw new Error(`Could not read "${file.name}" as an image`);
    }
  }
}

/** Encodes as WebP, falling back to JPEG if the encoder refuses. */
async function encodeCanvas(
  canvas: OffscreenCanvas,
  quality: number,
): Promise<Blob> {
  try {
    return await canvas.convertToBlob({ type: 'image/webp', quality });
  } catch (_e) {
    return await canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
}

/**
 * Downscales (and optionally crops) an image entirely in the browser and
 * re-encodes it. Used to keep icon/avatar uploads tiny: this is a
 * local-first app, so files must be small at rest — consumers render the
 * stored bytes as-is and cannot rely on a server-side resize endpoint.
 *
 * Throws (with a user-presentable message) when the file cannot be decoded
 * or re-encoded; callers should surface that via the errorHandler.
 */
export async function resizeImageFile(
  file: File,
  { maxSize, square = false, quality = 0.8, sourceRect }: ResizeImageOptions,
): Promise<File> {
  const decoded = await decodeImage(file);

  try {
    let sx = 0;
    let sy = 0;
    let sw = decoded.width;
    let sh = decoded.height;

    if (sourceRect) {
      sx = sourceRect.x;
      sy = sourceRect.y;
      sw = sourceRect.width;
      sh = sourceRect.height;
    } else if (square) {
      const side = Math.min(sw, sh);
      sx = (sw - side) / 2;
      sy = (sh - side) / 2;
      sw = side;
      sh = side;
    }

    const scale = Math.min(1, maxSize / Math.max(sw, sh));
    const width = Math.max(1, Math.round(sw * scale));
    const height = Math.max(1, Math.round(sh * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Could not create a canvas to resize the image');
    }

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, sx, sy, sw, sh, 0, 0, width, height);

    const blob = await encodeCanvas(canvas, quality);
    const extension = blob.type === 'image/webp' ? '.webp' : '.jpg';
    const name = file.name.replace(/\.[^.]*$/, '') + extension;

    return new File([blob], name, { type: blob.type });
  } finally {
    decoded.cleanup();
  }
}
