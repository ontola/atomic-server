/**
 * Tauri push / local-notification bridge (Phase 5).
 *
 * - **Cold start (local):** drain `active()` notifications that carry our
 *   `extra.about` before React mounts, mirroring {@link deepLinkQueue}.
 * - **Remote push:** optionally load `tauri-plugin-push-notifications` for a
 *   device token. The Rust plugin is mobile-only and needs APNs / Firebase
 *   project files — until those are present, token fetch no-ops.
 *
 * Chosen plugin: `tauri-plugin-push-notifications` (see
 * `planning/notifications.md` open question 7).
 */

import { isRunningInTauri } from './tauri';
import { queuePushWakeReceive, queuePushWakeTap } from './pushWakeTap';

export type PushTokenListener = (token: string, platform: 'ios' | 'android') => void;

let pushTokenListener: PushTokenListener | undefined;
let cachedPushToken: string | undefined;
let cachedPlatform: 'ios' | 'android' | undefined;

function aboutFromExtra(extra: unknown): string | undefined {
  if (!extra || typeof extra !== 'object') {
    return undefined;
  }

  const about = (extra as { about?: unknown }).about;

  return typeof about === 'string' && about.length > 0 ? about : undefined;
}

function typeFromExtra(extra: unknown): string {
  if (!extra || typeof extra !== 'object') {
    return 'mention';
  }

  const t = (extra as { type?: unknown; notificationType?: unknown }).type
    ?? (extra as { notificationType?: unknown }).notificationType;

  return typeof t === 'string' && t.length > 0 ? t : 'mention';
}

/**
 * Drain active local notifications that launched / are showing the app.
 * Safe to call before React; taps land in {@link queuePushWakeTap}.
 */
export async function drainColdStartNotificationTaps(): Promise<void> {
  if (!isRunningInTauri()) {
    return;
  }

  try {
    const { active } = await import('@tauri-apps/plugin-notification');
    const list = await active();

    for (const n of list) {
      const about = aboutFromExtra(n.extra);

      if (about) {
        queuePushWakeTap(about);
      }
    }
  } catch {
    // Plugin missing or unsupported on this target.
  }
}

/**
 * Subscribe for a remote push device token when the push plugin is present.
 * Returns an unsubscribe. Immediate if a token was already cached.
 */
export function onPushDeviceToken(listener: PushTokenListener): () => void {
  pushTokenListener = listener;

  if (cachedPushToken && cachedPlatform) {
    listener(cachedPushToken, cachedPlatform);
  }

  return () => {
    if (pushTokenListener === listener) {
      pushTokenListener = undefined;
    }
  };
}

function detectNativePushPlatform(): 'ios' | 'android' | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }

  const ua = navigator.userAgent || '';

  if (/Android/i.test(ua)) {
    return 'android';
  }

  // Tauri iOS webview
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return 'ios';
  }

  return undefined;
}

/**
 * Try to read a remote push token from `tauri-plugin-push-notifications`.
 * No-ops on desktop / when the plugin is not linked.
 */
export async function refreshPushDeviceToken(): Promise<string | undefined> {
  if (!isRunningInTauri()) {
    return undefined;
  }

  const platform = detectNativePushPlatform();

  if (!platform) {
    return undefined;
  }

  try {
    // Optional dependency — present once desktop Cargo + npm are wired for mobile.
    const mod = await import('tauri-plugin-push-notifications');
    const token = await mod.pushToken();

    if (!token) {
      return undefined;
    }

    cachedPushToken = token;
    cachedPlatform = platform;
    pushTokenListener?.(token, platform);

    return token;
  } catch {
    return undefined;
  }
}

/**
 * Parse a remote wake payload (data message or visible APNs/FCM notification)
 * into our receive queue. Call from plugin event handlers when they exist.
 */
export function ingestRemotePushPayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const data = payload as Record<string, unknown>;
  // Nested `data` bag (FCM) or flat wake payload. APNs puts custom keys next
  // to `aps`.
  const bag: Record<string, unknown> =
    data.data && typeof data.data === 'object'
      ? (data.data as Record<string, unknown>)
      : data;
  const about =
    typeof bag.about === 'string'
      ? bag.about
      : aboutFromExtra(bag) ?? aboutFromExtra(data.extra);

  if (!about) {
    return;
  }

  const type = typeFromExtra(bag) || typeFromExtra(data);
  const tapped =
    data.userInteraction === true || data.actionId === 'tap';

  if (tapped) {
    queuePushWakeTap(about);
  } else {
    queuePushWakeReceive({ about, type });
  }
}

async function subscribeRemotePushEvents(): Promise<void> {
  if (!isRunningInTauri()) {
    return;
  }

  try {
    const { listen } = await import('@tauri-apps/api/event');
    // Best-effort: plugin / OS may emit any of these when a remote push lands.
    for (const name of [
      'push-notification',
      'push://notification',
      'plugin:push-notifications://notification',
    ]) {
      void listen(name, event => {
        ingestRemotePushPayload(event.payload);
      });
    }
  } catch {
    // Event API unavailable.
  }
}

/** Test helper. */
export function __resetPushBridgeForTests(): void {
  pushTokenListener = undefined;
  cachedPushToken = undefined;
  cachedPlatform = undefined;
}

// Module-scope: same pattern as deepLinkQueue — run before React mounts.
if (typeof window !== 'undefined' && isRunningInTauri()) {
  void drainColdStartNotificationTaps();
  void refreshPushDeviceToken();
  void subscribeRemotePushEvents();
}
