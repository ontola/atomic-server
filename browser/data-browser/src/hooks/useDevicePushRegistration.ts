import { useEffect } from 'react';
import {
  registerDevicePushToken,
  type PushPlatform,
  useStore,
} from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import { getOrCreateNotificationsFolder } from '../helpers/notificationsFolder';
import { isRunningInTauri } from '../helpers/tauri';

/**
 * Register / refresh a {@link DevicePushToken} when a platform token exists.
 *
 * Phase 5: no FCM/APNs plugin yet. In production this no-ops until a token is
 * supplied (plugin callback). In Tauri desktop we register a stable stub so
 * the ontology path is exercised without a push provider.
 *
 * Pass `token` once the push plugin delivers a registration id.
 */
export function useDevicePushRegistration(token?: string): void {
  const store = useStore();
  const { agent } = useSettings();

  useEffect(() => {
    if (!agent?.subject) {
      return;
    }

    const platform = detectPushPlatform();
    const effectiveToken =
      token ??
      (import.meta.env.DEV && isRunningInTauri()
        ? `stub:desktop:${agent.subject.slice(-12)}`
        : undefined);

    if (!effectiveToken) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const personalDrive = await fetchPersonalDriveSubject(store, agent);

        if (!personalDrive || cancelled) {
          return;
        }

        const folder = await getOrCreateNotificationsFolder(
          store,
          personalDrive,
        );

        if (cancelled) {
          return;
        }

        await registerDevicePushToken({
          store,
          parent: folder,
          agentSubject: agent.subject,
          platform,
          token: effectiveToken,
          appId:
            typeof window !== 'undefined' ? window.location.origin : undefined,
        });
      } catch {
        // Registry write is best-effort until push is product-critical.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [store, agent, token]);
}

function detectPushPlatform(): PushPlatform {
  if (isRunningInTauri()) {
    return 'desktop';
  }

  return 'web';
}
