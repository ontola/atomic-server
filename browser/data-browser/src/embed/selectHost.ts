import type { NativeChannel } from '@tomic/lib';
import { createFlutterHost, flutterChannel } from './flutterHost';

/** Real native/Flutter hosts are synchronous. The standalone browser demo is
 * the only consumer of the mock's bundled ontology and sample resources. */
export function selectEmbedHost(
  nativeHost?: NativeChannel,
): NativeChannel | Promise<NativeChannel> {
  if (nativeHost) return nativeHost;
  const flutter = flutterChannel();
  if (flutter) return createFlutterHost(flutter);

  return import('./mockHost').then(({ createMockHost }) => createMockHost());
}
