// @wc-ignore-file
import { dataBrowser, type Store } from '@tomic/lib';
import { isHttpsOrLoopback } from '@helpers/runtimeSetting';
import { resizeImageFile } from '@tomic/resource-ui/helpers/resizeImage';

/** Install an image as an ordinary Atomic File; reopening uses stored bytes. */
export async function installIntegrationIcon(
  store: Pick<Store, 'getResource' | 'uploadFiles'>,
  app: string,
  icon: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const resource = await store.getResource(app);
  if (!icon || resource.get(dataBrowser.properties.icon)) return;
  const url = new URL(icon);
  if (!isHttpsOrLoopback(url) || url.username || url.password || url.hash)
    throw new Error('Invalid integration icon URL');
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    credentials: 'omit',
    redirect: 'error',
    headers: { Accept: 'image/png, image/jpeg, image/webp, image/svg+xml' },
  });
  const type = response.headers.get('Content-Type')?.split(';')[0];
  if (!response.ok || !type || !/^image\/(png|jpeg|webp|svg\+xml)$/.test(type))
    throw new Error('Could not read the integration icon');
  const limit = 262_144;
  if (Number(response.headers.get('Content-Length')) > limit)
    throw new Error('Integration icon exceeds 256 KB');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The integration icon is empty');
  const chunks: ArrayBuffer[] = [];
  let size = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Integration icon exceeds 256 KB');
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy.buffer);
    }
  } finally {
    await reader.cancel();
  }

  signal.throwIfAborted();
  const image = await resizeImageFile(
    new File(chunks, 'integration-icon', { type }),
    { maxSize: 128, square: true },
  );
  signal.throwIfAborted();
  if (resource.get(dataBrowser.properties.icon)) return;
  const [subject] = await store.uploadFiles([image], app);
  signal.throwIfAborted();
  if (resource.get(dataBrowser.properties.icon)) return;
  if (!subject) throw new Error('Could not save the integration icon');
  await resource.set(dataBrowser.properties.icon, subject);
  await resource.save();
}
