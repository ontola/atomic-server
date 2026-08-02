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
import {
  onPushDeviceToken,
  refreshPushDeviceToken,
} from '../helpers/tauriPushBridge';

/**
 * Register / refresh a {@link DevicePushToken} when a platform token exists.
 *
 * Prefers a real FCM/APNs token from {@link refreshPushDeviceToken}. Falls back
 * to a DEV stub on Tauri desktop so the ontology path is exercised without a
 * push provider.
 */
export function useDevicePushRegistration(token?: string): void {
  const store = useStore();
  const { agent } = useSettings();

  useEffect(() => {
    if (!agent?.subject) {
      return;
    }

    let cancelled = false;

    const upsert = async (
      effectiveToken: string,
      platform: PushPlatform,
    ) => {
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
    };

    if (token) {
      void upsert(token, detectPushPlatform());
    }

    const unsub = onPushDeviceToken((t, platform) => {
      void upsert(t, platform);
    });

    void (async () => {
      const remote = await refreshPushDeviceToken();

      if (remote || cancelled) {
        return;
      }

      // DEV desktop stub so DevicePushToken ontology is exercised without FCM.
      if (import.meta.env.DEV && isRunningInTauri()) {
        await upsert(
          `stub:desktop:${agent.subject.slice(-12)}`,
          'desktop',
        );
      }
    })();

    return () => {
      cancelled = true;
      unsub();
    };
  }, [store, agent, token]);
}

function detectPushPlatform(): PushPlatform {
  if (isRunningInTauri()) {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

    if (/Android/i.test(ua)) {
      return 'android';
    }

    if (/iPhone|iPad|iPod/i.test(ua)) {
      return 'ios';
    }

    return 'desktop';
  }

  return 'web';
}
