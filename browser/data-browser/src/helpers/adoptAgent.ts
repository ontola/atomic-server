// @wc-ignore-file
// Tell this device's embedded node to act as the signed-in agent.
//
// `atomic-server` mints an agent for itself on first boot and treats it as root
// of its own store. On a hosted server that's coherent — the server is a
// principal. On a phone it isn't: you are. Left alone, the node signs peer AUTH
// as that stranger, the other device's `check_read` denies it every subject,
// and the sync completes having moved nothing.
//
// This runs at the only moment the secret exists outside the keystore: sign-in.
// The private key is stored non-extractable (see `agentStorage.ts`), so the
// browser cannot hand it over a second time — the node persists it instead.
//
// Deliberately a Tauri command rather than an HTTP call: the embedded server
// listens on localhost, which any other app on Android can reach, and an
// endpoint that sets the node's root identity would be a handover of the
// device. Tauri IPC is callable only from our own webview.
//
// Best-effort by design. A failure here leaves the device usable — it just
// can't peer-sync until the next sign-in. It must never block onboarding.

import { isRunningInTauri } from './tauri';

export async function adoptAgentOnDevice(secret: string): Promise<void> {
  if (!isRunningInTauri()) {
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('adopt_agent', { secret });
  } catch (e) {
    console.error('[identity] the local node kept its own agent:', e);
  }
}
