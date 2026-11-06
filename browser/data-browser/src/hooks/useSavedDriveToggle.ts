import { useCallback } from 'react';
import { useDriveHistory } from './useDriveHistory';
import { useSavedDrives } from './useSavedDrives';

/**
 * Whether `subject` is one of My drives, and a toggle for it. A drive leaves
 * Recently visited when it is saved and returns there when it is removed.
 */
export function useSavedDriveToggle(
  subject: string,
): [isSaved: boolean, toggle: () => void] {
  const [savedDrives, saveDrive, unsaveDrive] = useSavedDrives();
  const [, addToHistory, removeFromHistory] = useDriveHistory();
  const isSaved = savedDrives.includes(subject);

  const toggle = useCallback(() => {
    if (isSaved) {
      unsaveDrive(subject);
      addToHistory(subject);
    } else {
      saveDrive(subject);
      removeFromHistory(subject);
    }
  }, [
    subject,
    isSaved,
    saveDrive,
    unsaveDrive,
    addToHistory,
    removeFromHistory,
  ]);

  return [isSaved, toggle];
}
