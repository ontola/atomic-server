// @wc-ignore-file
import {
  contacts,
  core,
  Datatype,
  type QueryFilter,
  type Resource,
  type Store,
} from '@tomic/react';

export interface PendingInvite {
  /** The Contact in the inviter's private drive. */
  subject: string;
  /** Empty for an invite link: it is not addressed to anyone. */
  email: string;
  /** True when this records a copied invite link rather than an email invite. */
  link?: boolean;
  role: 'read' | 'write';
  sentAt?: number;
}

/**
 * An invite sent by email is kept as a Contact in the inviter's own private
 * drive, never on the shared resource, so the address stays private. The
 * address is not stored anywhere an Agent could be matched to it, so the
 * Contact stays until the inviter removes it.
 */
export function pendingInviteQuery(
  privateDrive: string | undefined,
  target: string,
): QueryFilter {
  return {
    property: contacts.properties.invitedTo,
    value: target,
    filters: [
      { property: core.properties.isA, value: contacts.classes.contact },
    ],
    drive: privateDrive,
    sort_by: contacts.properties.invitedAt,
  };
}

/**
 * Copying an invite link is recorded like an email invite, so that "someone
 * was invited" is derivable and syncs across devices. The Contact class
 * requires `email`, so a link record keeps it as an empty string: it is
 * addressed to nobody. Changing the class to make it optional would need every
 * server to be upgraded first; an empty address needs nothing.
 */
export const INVITE_LINK_NAME = 'Invite link';

export function pendingInviteProps(
  invite: Omit<PendingInvite, 'subject'> & { target: string },
): Record<string, string | number> {
  return {
    // Data, not UI: the list shows "Invite link" in the viewer's language.
    [core.properties.name]: invite.email || INVITE_LINK_NAME,
    [contacts.properties.email]: invite.email,
    [contacts.properties.invitedTo]: invite.target,
    [contacts.properties.invitedRole]: invite.role,
    [contacts.properties.invitedAt]: invite.sentAt ?? Date.now(),
  };
}

/** Reads a Contact as a pending invite, or undefined if it is not one. */
export function toPendingInvite(resource: Resource): PendingInvite | undefined {
  const email = resource.get(contacts.properties.email);

  if (typeof email !== 'string') return undefined;

  const role = resource.get(contacts.properties.invitedRole);
  const sentAt = resource.get(contacts.properties.invitedAt);

  return {
    subject: resource.subject,
    email,
    ...(email === '' ? { link: true } : {}),
    role: role === 'write' ? 'write' : 'read',
    sentAt: typeof sentAt === 'number' ? sentAt : undefined,
  };
}

export async function savePendingInvites(
  store: Store,
  privateDrive: string,
  target: string,
  emails: string[],
  role: 'read' | 'write',
): Promise<void> {
  const sentAt = Date.now();

  await Promise.all(
    emails.map(async email => {
      const contact = await store.newResource({
        parent: privateDrive,
        isA: contacts.classes.contact,
        propVals: pendingInviteProps({ email, target, role, sentAt }),
        propDatatypes: {
          [contacts.properties.email]: Datatype.STRING,
          [contacts.properties.invitedTo]: Datatype.ATOMIC_URL,
          [contacts.properties.invitedRole]: Datatype.STRING,
          [contacts.properties.invitedAt]: Datatype.TIMESTAMP,
        },
      });
      await contact.save();
      store.notifyResourceManuallyCreated(contact);
    }),
  );
}

/** Records that an invite link for `target` was copied. */
export function savePendingInviteLink(
  store: Store,
  privateDrive: string,
  target: string,
  role: 'read' | 'write',
): Promise<void> {
  return savePendingInvites(store, privateDrive, target, [''], role);
}
