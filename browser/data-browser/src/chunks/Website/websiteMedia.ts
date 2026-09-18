// @wc-ignore-file
import { server, hexToBytes, type Store } from '@tomic/lib';
import { optimizeWebsiteImage } from './optimizeWebsiteImage';

/** Export only an explicitly selected File; never follow its parent or other links. */
export async function snapshotWebsiteImage(
  store: Store,
  subject: string,
): Promise<Blob> {
  const file = await store.getResource(subject);
  if (file.error || file.loading || !file.hasClasses(server.classes.file))
    throw new Error(`Cannot read selected image: ${subject}`);

  try {
    const mime = file.get(server.properties.mimetype);
    if (typeof mime !== 'string' || !/^image\/(png|jpeg|webp|gif)$/.test(mime))
      throw new Error('Website images must be PNG, JPEG, WebP or GIF.');
    const blob = file.get('https://atomicdata.dev/properties/blob');
    let bytes: Uint8Array | null | undefined;
    if (typeof blob === 'string' && /^did:ad:blob:[a-f0-9]{64}$/.test(blob))
      bytes = await store
        .getClientDb()
        ?.getBlob(hexToBytes(blob.slice('did:ad:blob:'.length)));

    if (!bytes) {
      const url = file.get(server.properties.downloadUrl);
      if (typeof url !== 'string' || !/^https?:\/\//.test(url))
        throw new Error(
          'Selected image bytes are unavailable. Reconnect and try again.',
        );
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok)
        throw new Error(
          `Could not download selected image (${response.status}).`,
        );
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Selected image download has no body.');
      const chunks: Uint8Array[] = [];
      let size = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;

        if (size > 50_000_000) {
          await reader.cancel();
          throw new Error('Source image exceeds the 50 MB processing limit.');
        }

        chunks.push(value);
      }

      bytes = new Uint8Array(size);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    }

    if (bytes.length > 50_000_000)
      throw new Error('Source image exceeds the 50 MB processing limit.');
    const optimized = await optimizeWebsiteImage(
      new Blob([bytes as BlobPart], { type: mime }),
    );

    return optimized;
  } catch (error) {
    throw new Error(
      `Image "${file.title}" (${subject}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
