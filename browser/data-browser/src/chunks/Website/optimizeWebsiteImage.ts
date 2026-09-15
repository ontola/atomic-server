// @wc-ignore-file
const MAX_EDGE = 1920;
const TARGET_BYTES = 600_000;

/** Browser-native derivatives: original Atomic File bytes are never changed. */
export async function optimizeWebsiteImage(source: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;

  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new Error(
      'Image could not be decoded. Try a valid JPEG, PNG or WebP file.',
    );
  }

  try {
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width * bitmap.height > 80_000_000
    )
      throw new Error('Image exceeds the 80 megapixel processing limit.');
    if (source.type === 'image/gif' && source.size > 2_000_000)
      throw new Error(
        'Animated GIF exceeds 2 MB. Use a smaller GIF or a static image.',
      );
    // Preserve GIF animation instead of silently replacing it with its first frame.
    if (
      source.type === 'image/gif' ||
      (source.size <= TARGET_BYTES &&
        Math.max(bitmap.width, bitmap.height) <= MAX_EDGE)
    )
      return source;
    let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot optimize images.');

    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const encoded = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          blob =>
            blob ? resolve(blob) : reject(new Error('Image encoding failed.')),
          'image/webp',
          0.82,
        ),
      );
      if (encoded.size <= TARGET_BYTES) return encoded;
      scale *= 0.75;
    }

    throw new Error('Image could not be reduced to the website asset budget.');
  } finally {
    bitmap.close();
  }
}
