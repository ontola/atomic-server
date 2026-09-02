// @wc-ignore-file
// The native QR scanner, wrapped so every pairing surface opens the camera the
// same way. The Android WebView won't grant `getUserMedia` to web content, so
// a browser-side BarcodeDetector scanner can't work here: the Tauri plugin
// owns the camera and the permission prompt, and hands back the decoded text.
//
// Mobile only — the plugin isn't compiled into the desktop app (see
// desktop/Cargo.toml). Callers should hide their scan affordance behind
// `isMobileTauri()` rather than relying on the `unavailable` result.

import { isMobileTauri } from './tauri';

export type ScanResult =
  /** The user scanned something. Not yet known to be a pairing code. */
  | { kind: 'code'; code: string }
  /** Camera permission was refused. */
  | { kind: 'denied' }
  /** The scanner closed without reading anything. Not an error. */
  | { kind: 'cancelled' }
  /** No scanner on this platform, or it failed to open. */
  | { kind: 'unavailable' };

export async function scanPairingCode(): Promise<ScanResult> {
  if (!isMobileTauri()) {
    return { kind: 'unavailable' };
  }

  try {
    const scanner = await import('@tauri-apps/plugin-barcode-scanner');
    let permission = await scanner.checkPermissions();

    if (permission !== 'granted') {
      permission = await scanner.requestPermissions();
    }

    if (permission !== 'granted') {
      return { kind: 'denied' };
    }

    const result = await scanner.scan({ formats: [scanner.Format.QRCode] });

    return result?.content
      ? { kind: 'code', code: result.content }
      : { kind: 'cancelled' };
  } catch {
    return { kind: 'unavailable' };
  }
}
