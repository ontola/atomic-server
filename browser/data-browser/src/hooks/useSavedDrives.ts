import { urls, useStore } from '@tomic/react';
import { usePrivateDriveList } from './usePrivateDriveList';
import { useDriveListManagement } from './useDriveListManagement';
import { visibleDrives } from '../helpers/driveListManagement';

/**
 * The user's saved drives (the drive-switcher list). Stored as the `drives`
 * ResourceArray on the user's PRIVATE DRIVE — the per-user home index — not on
 * the Agent. See {@link usePrivateDriveList}.
 */
export function useSavedDrives(): [
  savedDrives: string[],
  add: (drive: string) => void,
  remove: (drive: string) => void,
] {
  const [saved] = usePrivateDriveList(urls.properties.drives);
  const { hidden, setVisible } = useDriveListManagement();
  const store = useStore();

  const update = (subject: string, visible: boolean) => {
    void setVisible([subject], visible).catch(error =>
      store.notifyError(error),
    );
  };

  return [
    visibleDrives(saved, hidden),
    subject => update(subject, true),
    subject => update(subject, false),
  ];
}
