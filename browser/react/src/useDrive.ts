import { StoreEvents } from '@tomic/lib';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from './index.js';

/**
 * A hook for using and adjusting the current Drive.
 */
export const useDrive = (): [string, (drive: string) => void] => {
  const store = useStore();
  const [drive, setDrive] = useState<string>(store.getDrive());

  const set = useCallback(
    (value: string) => {
      store.setDrive(value);
    },
    [store],
  );

  useEffect(() => {
    return store.on(StoreEvents.DriveChanged, newDrive => {
      setDrive(newDrive);
    });
  }, [store]);

  return [drive, set];
};
