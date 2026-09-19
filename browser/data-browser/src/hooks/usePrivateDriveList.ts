import { useArray, useResource, useStore } from '@tomic/react';
import { useCallback } from 'react';
import { usePrivateDrive } from './usePrivateDrive';

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
 *
 * Add/remove are CRDT list ops (`push` / `removeItems`), not whole-array
 * `set()`. Two devices starring different resources keep both.
 */
export function usePrivateDriveList(
  property: string,
): [
  list: string[],
  add: (subject: string) => void,
  remove: (subject: string) => void,
] {
  const store = useStore();
  const { privateDrive } = usePrivateDrive();
  const driveResource = useResource(privateDrive);
  const [list, , pushList, removeList] = useArray(driveResource, property);

  const persistError = useCallback(
    (e: unknown) => {
      store.notifyError(e instanceof Error ? e : new Error(String(e)));
    },
    [store],
  );

  const noDriveError = useCallback(() => {
    store.notifyError(
      new Error(
        'Could not update your list: no private drive is set up for this account yet.',
      ),
    );
  }, [store]);

  const add = useCallback(
    (subject: string) => {
      if (!privateDrive) {
        noDriveError();

        return;
      }

      if (list.includes(subject)) {
        return;
      }

      pushList([subject]);
      void driveResource.stable.save().catch(persistError);
    },
    [
      privateDrive,
      list,
      pushList,
      driveResource.stable,
      noDriveError,
      persistError,
    ],
  );

  const remove = useCallback(
    (subject: string) => {
      if (!privateDrive) {
        noDriveError();

        return;
      }

      if (!list.includes(subject)) {
        return;
      }

      removeList([subject]);
      void driveResource.stable.save().catch(persistError);
    },
    [
      privateDrive,
      list,
      removeList,
      driveResource.stable,
      noDriveError,
      persistError,
    ],
  );

  return [privateDrive ? list : [], add, remove];
}
