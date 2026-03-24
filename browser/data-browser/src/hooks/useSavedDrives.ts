import { urls, useArray, useResource } from '@tomic/react';
import { useCallback, useMemo } from 'react';
import { isDev } from '../config';
import { useSettings } from '../helpers/AppSettings';
import { serverURLStorage } from '../helpers/serverURLStorage';

const getRootDrives = () => {
  const known = serverURLStorage.getKnownServers();
  const current = isDev() ? 'http://localhost:9883' : window.location.origin;

  const roots = new Set([current, ...known]);

  if (isDev()) {
    roots.add('http://localhost:9883');
  }

  return Array.from(roots);
};

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

  const rootDrives = useMemo(() => getRootDrives(), []);
  const extraDrives = useMemo(() => {
    return drives;
  }, [drives]);

  const add = useCallback(
    (drive: string) => {
      if (!drives.includes(drive)) {
        setDrives([...drives, drive]).then(() => {
          agentResource.save();
        });
      }
    },
    [drives, setDrives],
  );

  const remove = useCallback(
    (drive: string) => {
      if (drives.includes(drive)) {
        setDrives(drives.filter(d => d !== drive)).then(() => {
          agentResource.save();
        });
      }
    },
    [drives, setDrives],
  );

  return [drives, add, remove];
}
