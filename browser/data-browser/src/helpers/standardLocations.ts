import { ai, core, dataBrowser, type Store } from '@tomic/react';

/**
 * Standard locations are well-known resources inside a Drive (the Comments
 * folder, the default ontology, the tag list, …) that clients find by
 * following a dedicated property on the Drive itself — never by name or by
 * guessing subjects. This helper is the generic get-or-create for such a
 * pointer: read the property, or create the resource and set the pointer.
 *
 * Creation is client-side and signed by the current agent (requires write on
 * the drive). Two clients racing on first use can each create a resource and
 * LWW decides which pointer wins — harmless as long as the standard location
 * is a container/anchor rather than the source of truth (e.g. comments are
 * found via their `about` property, not by enumerating the Comments folder).
 */
export async function getOrCreateDriveLocation(
  store: Store,
  driveSubject: string,
  pointerProperty: string,
  create: { isA: string; name: string },
): Promise<string> {
  const drive = await store.getResource(driveSubject);
  const existing = drive.get(pointerProperty) as string | undefined;

  if (existing) {
    // A pointer to a deleted/broken resource should not be returned —
    // recreate instead (the stale pointer gets overwritten below).
    const target = await store.getResource(existing);

    if (!target.error) {
      return existing;
    }
  }

  const resource = await store.newResource({
    parent: driveSubject,
    isA: create.isA,
    propVals: { [core.properties.name]: create.name },
  });
  await resource.save();
  store.notifyResourceManuallyCreated(resource);

  await drive.set(pointerProperty, resource.subject);
  await drive.save();

  return resource.subject;
}

/** The Drive's Comments folder: default parent (= rights anchor) for comment Messages. */
export async function getOrCreateCommentsFolder(
  store: Store,
  driveSubject: string,
): Promise<string> {
  return getOrCreateDriveLocation(
    store,
    driveSubject,
    dataBrowser.properties.commentsFolder,
    { isA: dataBrowser.classes.folder, name: /* @wc-ignore */ 'Comments' },
  );
}

/** The Drive's AI Chats folder: home for sidebar AI chats (usually on the personal drive). */
export async function getOrCreateAiChatsFolder(
  store: Store,
  driveSubject: string,
): Promise<string> {
  return getOrCreateDriveLocation(
    store,
    driveSubject,
    ai.properties.aiChatsFolder,
    { isA: dataBrowser.classes.folder, name: /* @wc-ignore */ 'AI Chats' },
  );
}

/** The Drive's Meetings folder: home for Meeting resources, so live and
 *  past meetings don't clutter the drive root. */
export async function getOrCreateMeetingsFolder(
  store: Store,
  driveSubject: string,
): Promise<string> {
  return getOrCreateDriveLocation(
    store,
    driveSubject,
    dataBrowser.properties.meetingsFolder,
    { isA: dataBrowser.classes.folder, name: /* @wc-ignore */ 'Meetings' },
  );
}

/** The Drive's follow-sessions ChatRoom: while an agent is being followed,
 *  their client logs which resources they visit here (issue #1229). */
export async function getOrCreateFollowSessionsChatroom(
  store: Store,
  driveSubject: string,
): Promise<string> {
  return getOrCreateDriveLocation(
    store,
    driveSubject,
    dataBrowser.properties.followSessionsChatroom,
    {
      isA: dataBrowser.classes.chatroom,
      name: /* @wc-ignore */ 'Follow sessions',
    },
  );
}
