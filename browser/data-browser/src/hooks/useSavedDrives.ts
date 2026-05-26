import { urls, useArray, useResource } from '@tomic/react';
import { useCallback } from 'react';
import { useSettings } from '../helpers/AppSettings';

const arrayOpts = {
  commit: true,
};

export function useSavedDrives(): [
  savedDrives: string[],
  add: (drive: string) => void,
  remove: (drive: string) => void,
] {
  const { agent } = useSettings();
  const agentResource = useResource(agent?.subject);
  const [drives, setDrives] = useArray(
    agentResource,
    urls.properties.drives,
    arrayOpts,
  );

  const add = useCallback(
    (drive: string) => {
      if (!drives.includes(drive)) {
        setDrives([...drives, drive]).then(() => {
          agentResource.stable.save();
        });
      }
    },
    [drives, setDrives, agentResource.stable],
  );

  const remove = useCallback(
    (drive: string) => {
      if (drives.includes(drive)) {
        setDrives(drives.filter(d => d !== drive)).then(() => {
          agentResource.stable.save();
        });
      }
    },
    [drives, setDrives, agentResource.stable],
  );

  return [drives, add, remove];
}
