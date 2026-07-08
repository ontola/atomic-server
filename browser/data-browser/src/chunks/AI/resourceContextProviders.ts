// @wc-ignore-file
/**
 * Per-class context providers (phase 2 of planning/json-ad-compact.md): when
 * a resource is attached to a chat, the matching provider expands it into
 * what a person viewing it actually sees, so acting on "this <thing>" needs
 * no discovery tool calls. Tables carry their row schema + rows; chatrooms
 * their recent messages. Add a provider here when another class view gets a
 * chat entry point.
 */
import {
  CollectionBuilder,
  commits,
  core,
  dataBrowser,
  type Resource,
  type Store,
} from '@tomic/react';
import { shortenSubject } from '@helpers/subjectRefs';
import { getTableContextForAgent } from './tableContextProvider';

const MESSAGE_SAMPLE_LIMIT = 10;

/**
 * Renders the chatroom's message count and its last {@link
 * MESSAGE_SAMPLE_LIMIT} messages (oldest first, like the chat view), plus a
 * recipe for posting and for paging further back.
 */
const getChatroomContextForAgent = async (
  store: Store,
  chatroom: Resource,
): Promise<string> => {
  const collection = new CollectionBuilder(store)
    .setProperty(core.properties.parent)
    .setValue(chatroom.subject)
    .setFilters([
      { property: core.properties.isA, value: dataBrowser.classes.message },
    ])
    .setSortBy(commits.properties.createdAt)
    .setSortDesc(true)
    .setPageSize(MESSAGE_SAMPLE_LIMIT)
    .build();

  // Newest page first; fetching it also populates totalMembers.
  const newestFirst = await collection.getMembersOnPage(0);
  const total = collection.totalMembers;

  const lines: string[] = [];

  for (const subject of [...newestFirst].reverse()) {
    const message = await store.getResource(subject);

    if (message.error) {
      continue;
    }

    const text = message.get(core.properties.description) ?? '';
    const createdAt = message.getCreatedAt();
    const createdBy = message.getCreatedBy();
    const author = createdBy
      ? (await store.getResource(createdBy)).title
      : 'unknown';
    const time = createdAt ? new Date(createdAt).toISOString() : '';

    lines.push(
      `[${time}] ${author} (${shortenSubject(subject)}): ${text}`.trim(),
    );
  }

  const shownNote =
    total > lines.length ? ` (last ${lines.length} shown, oldest first)` : '';

  return [
    `Messages: ${total}${shownNote}`,
    ...lines,
    `To post a message: create_resource with {"@class": "${dataBrowser.classes.message}", "@parent": "${shortenSubject(chatroom.subject)}", "description": "<text>"}. To read older messages: query with class "${dataBrowser.classes.message}" and where [{"property": "${core.properties.parent}", "value": "${shortenSubject(chatroom.subject)}"}].`,
  ].join('\n');
};

/**
 * Returns the class-specific context block for an attached resource, or
 * undefined when no provider matches.
 */
export const getClassContextForAgent = async (
  store: Store,
  resource: Resource,
): Promise<string | undefined> => {
  if (resource.hasClasses(dataBrowser.classes.table)) {
    return getTableContextForAgent(store, resource);
  }

  if (resource.hasClasses(dataBrowser.classes.chatroom)) {
    return getChatroomContextForAgent(store, resource);
  }

  return undefined;
};
