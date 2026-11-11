import {
  contacts,
  useCollection,
  useCollectionPage,
  useResources,
  useStore,
} from '@tomic/react';
import { usePrivateDrive } from '../../hooks/usePrivateDrive';
import { usePrivateDriveSync } from '../../hooks/usePrivateDriveSync';
import {
  pendingInviteQuery,
  savePendingInvites,
  toPendingInvite,
  type PendingInvite,
} from '../../helpers/pendingInvites';

/** The signed-in person's own invites by email to `target`, and a way to drop one. */
export function usePendingInvites(target: string): {
  invites: PendingInvite[];
  remove: (subject: string) => Promise<void>;
  /** Saves an invite per address, then shows them. */
  record: (emails: string[], role: 'read' | 'write') => Promise<void>;
} {
  const store = useStore();
  const { privateDrive } = usePrivateDrive();
  const { collection, invalidateCollection } = useCollection(
    pendingInviteQuery(privateDrive, target),
    { pageSize: 100 },
  );

  usePrivateDriveSync(privateDrive, invalidateCollection);

  const members = useCollectionPage(collection, 0);
  const resources = useResources(privateDrive ? members : []);

  const invites = [...resources.values()]
    .filter(
      r => !r.loading && !r.error && r.hasClasses(contacts.classes.contact),
    )
    .map(toPendingInvite)
    .filter((i): i is PendingInvite => !!i)
    .sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));

  const remove = async (subject: string) => {
    const contact = await store.getResource(subject);
    await contact.destroy();
    await invalidateCollection();
  };

  const record = async (emails: string[], role: 'read' | 'write') => {
    if (!privateDrive) return;

    // The saved Contact reaches the collection through the store's own change
    // events; no manual refresh.
    await savePendingInvites(store, privateDrive, target, emails, role);
  };

  return { invites, remove, record };
}
