// @wc-ignore-file
import { useEffect } from 'react';
import { useStore } from '@tomic/react';
import { useSettings } from '@helpers/AppSettings';
import { startDriveActivityRecorder } from '@helpers/driveActivityRecorder';

/** Mounted once: keeps the current drive's activity log up to date. Renders nothing. */
export function DriveActivityRecorder(): null {
  const store = useStore();
  const { drive } = useSettings();

  useEffect(() => {
    if (!drive) return;

    return startDriveActivityRecorder(store, drive);
  }, [store, drive]);

  return null;
}
