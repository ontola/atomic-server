import { useEffect } from 'react';
import toast from 'react-hot-toast';
import { isRunningInTauri } from '../../helpers/tauri';
import { ToastBody, ToastCard, ToastText, ToastTitle } from './toastStyles';

interface AvailableUpdate {
  version: string;
}

const TOAST_ID = 'desktop-update';

/**
 * Tells the person that a newer version of the desktop app is ready.
 *
 * The app itself looks for updates (`desktop/src/updates.rs`) and says so
 * with an `update-available` event; this only shows it. Nothing is installed
 * until the person clicks, because installing restarts the app and a restart
 * would drop whatever they are in the middle of. Renders nothing.
 */
export function DesktopUpdateNotice(): null {
  useEffect(() => {
    if (!isRunningInTauri()) return;

    let stopped = false;
    let unlisten: (() => void) | undefined;

    const install = async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      toast.loading('Installing the update…', { id: TOAST_ID });

      try {
        // Restarts the app when it succeeds, so there is no success to show.
        await invoke('install_update');
      } catch (e) {
        toast.error(typeof e === 'string' ? e : (e as Error).message, {
          id: TOAST_ID,
        });
      }
    };

    const show = ({ version }: AvailableUpdate) => {
      toast.custom(
        t => (
          <ToastCard
            onClick={() => {
              toast.dismiss(t.id);
              void install();
            }}
          >
            <ToastBody>
              <ToastTitle>Update available</ToastTitle>
              <ToastText>Restart to use version {version}</ToastText>
            </ToastBody>
          </ToastCard>
        ),
        { id: TOAST_ID, duration: Infinity },
      );
    };

    (async () => {
      const [{ listen }, { invoke }] = await Promise.all([
        import('@tauri-apps/api/event'),
        import('@tauri-apps/api/core'),
      ]);

      // The check may have finished before this page was listening.
      const waiting = await invoke<AvailableUpdate | null>('pending_update');
      if (waiting && !stopped) show(waiting);

      const off = await listen<AvailableUpdate>('update-available', event =>
        show(event.payload),
      );

      if (stopped) off();
      else unlisten = off;
    })().catch(() => undefined);

    return () => {
      stopped = true;
      unlisten?.();
    };
  }, []);

  return null;
}
