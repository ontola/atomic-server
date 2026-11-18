import { build } from 'vite';

// In-memory, no config/plugins/catalogs or output writer. Reuse the production
// RTCDataChannel implementation rather than duplicating framing in the fixture.
export async function buildNativeCarrier(entry) {
  const bundle = await build({
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      lib: { entry, name: 'NativeCarrierTransport', formats: ['iife'] },
    },
  });
  const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(
    item => item.type === 'chunk',
  );
  if (!code) throw new Error('Missing real WebRTC transport bundle');

  return code.code;
}
