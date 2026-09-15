// @wc-ignore-file
import { server, hexToBytes, type Store } from '@tomic/lib';

/** Export only an explicitly selected File; never follow its parent or other links. */
export async function snapshotWebsiteImage(
  store: Store,
  subject: string,
): Promise<string> {
  const file = await store.getResource(subject);
  if (file.error || file.loading || !file.hasClasses(server.classes.file))
    throw new Error(`Cannot read selected image: ${subject}`);
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

      if (size > 2_000_000) {
        await reader.cancel();
        throw new Error('Use an image smaller than 2 MB.');
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

  if (bytes.length > 2_000_000)
    throw new Error('Use an image smaller than 2 MB.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));

  return `data:${mime};base64,${btoa(binary)}`;
}
