import { useArray, useResource, useStore } from '@tomic/react';
import { useCallback } from 'react';
import { usePersonalDrive } from './usePersonalDrive';

const arrayOpts = { commit: true } as const;

/**
 * Read + write a ResourceArray that lives on the user's PRIVATE DRIVE — the
 * per-user "home index". The curated lists (`drives`, `sharedWithMe`,
 * `favorites`) are stored here rather than on the Agent identity resource:
 * they are user-owned indexes of global-subject pointers, and the private
 * drive is the one space the user owns and syncs everywhere. The targets they
 * point at may live on any drive/server and are resolved per-pointer.
 *
 * Returns `[list, add, remove]`. When there is no personal drive (signed out /
 * not yet provisioned) the list is empty and add/remove surface an error
 * rather than failing silently.
 */
export function usePersonalDriveList(
  property: string,
): [
  list: string[],
  add: (subject: string) => void,
  remove: (subject: string) => void,
] {
  const store = useStore();
  const { personalDrive } = usePersonalDrive();
  const driveResource = useResource(personalDrive);
  const [list, setList] = useArray(driveResource, property, arrayOpts);

  const persist = useCallback(
    (next: string[]) => {
      if (!personalDrive) {
        store.notifyError(
          new Error(
            'Could not update your list: no personal drive is set up for this account yet.',
          ),
        );

        return;
      }

      // Surface write failures (e.g. the server rejecting the commit, or
      // missing write access) instead of letting the rejected promise vanish.
      void setList(next)
        .then(() => driveResource.stable.save())
        .catch(e =>
          store.notifyError(e instanceof Error ? e : new Error(String(e))),
        );
    },
    [personalDrive, setList, driveResource.stable, store],
  );

  const add = useCallback(
    (subject: string) => {
      if (list.includes(subject)) {
        return;
      }

      persist([...list, subject]);
    },
    [list, persist],
  );

  const remove = useCallback(
    (subject: string) => {
      if (!list.includes(subject)) {
        return;
      }

      persist(list.filter(s => s !== subject));
    },
    [list, persist],
  );

  return [personalDrive ? list : [], add, remove];
}
