import {
  canonicalizeScheme,
  server,
  useArray,
  useResourceSnapshot,
} from '@tomic/react';
import { usePrivateDrive } from './usePrivateDrive';
import { setDriveListVisibility } from '../helpers/driveListManagement';

export function useDriveListManagement() {
  const { privateDrive } = usePrivateDrive();
  const { resource: home, ready, error } = useResourceSnapshot(privateDrive);
  const [hidden] = useArray(home, server.properties.hiddenDrives);

  return {
    hidden: [...new Set(hidden.map(canonicalizeScheme))].filter(
      s => canonicalizeScheme(s) !== canonicalizeScheme(privateDrive ?? ''),
    ),
    ready: !!privateDrive && ready && !error,
    async setVisible(subjects: string[], visible: boolean) {
      if (!privateDrive)
        throw new Error('Your private drive is not available yet.');
      await setDriveListVisibility(home.stable, subjects, visible);
    },
  };
}
