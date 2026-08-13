// @wc-ignore-file
// Open a URL outside the app.
//
// A plain `target="_blank"` works in a browser and silently fails in the
// desktop and Android apps: the webview has nowhere to put a tab, so Tauri
// intercepts the navigation and hands it to a plugin. It used to reach
// `shell.open`, which is denied without `shell:allow-open` and then fails on
// Android anyway with `Permission denied (os error 13)`. Both failures
// surfaced as an *empty* error toast, because the rejection is a bare string
// and the toast reads `.message` — so every external link in the app looked
// like a dead control.
//
// `opener` is the supported way to do this in Tauri v2 and is implemented on
// Android with an Intent.
import { invoke } from '@tauri-apps/api/core';
import { isRunningInTauri } from './tauri';

/**
 * Open `url` in the system browser.
 *
 * Returns nothing and throws nothing: a caller wiring up a link has no useful
 * recovery, and the previous behaviour — a rejected promise nobody awaited —
 * is what produced the blank toast.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isRunningInTauri()) {
    window.open(url, '_blank', 'noreferrer');

    return;
  }

  try {
    // The command the `@tauri-apps/plugin-opener` package wraps. Invoked
    // directly so the app does not carry a JS dependency for one call.
    await invoke('plugin:opener|open_url', { url });
  } catch (e) {
    // Worth a console line rather than a silent no-op: this is the layer that
    // has historically failed quietly.
    console.error('Could not open externally:', url, e);
  }
}
