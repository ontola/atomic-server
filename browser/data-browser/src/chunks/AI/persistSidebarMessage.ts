import { core, type Resource, type Store, type Ai } from '@tomic/react';
import type { AtomicUIMessage } from './types';
import {
  persistMessageResourceToServer,
  findMessageResource,
  upsertMessageInChat,
} from './chatConversionUtils';
import { DEFAULT_AICHAT_NAME } from '@components/AI/aiContstants';

export type DraftChatResource = Resource<Ai.AiChat>;
export type TitlePromise = Promise<string | undefined>;

export type PersistSidebarMessageArgs = {
  message: AtomicUIMessage;
  newMessages: AtomicUIMessage[];
  store: Store;
  getOrCreateDraftChatResource: () => Promise<DraftChatResource | undefined>;
  isChatSavedRef: React.MutableRefObject<boolean>;
  titlePromiseRef: React.MutableRefObject<TitlePromise | undefined>;
  setMessageToResourceMap: React.Dispatch<
    React.SetStateAction<Map<AtomicUIMessage, Resource>>
  >;
  messageToResourceMapRef: React.MutableRefObject<
    Map<AtomicUIMessage, Resource>
  >;
  setIsChatSaved: React.Dispatch<React.SetStateAction<boolean>>;
  shouldGenerateTitles: boolean;
  generateTitle: (messages: AtomicUIMessage[]) => TitlePromise;
  /** Token stream: mint once, then splice LoroText without HTTP save. */
  streaming?: boolean;
};

/**
 * When a sidebar chat stops being a draft and becomes a resource.
 *
 * On the user's message, not on the reply that follows it. The draft exists so
 * that opening the panel and typing nothing leaves nothing behind — but once
 * someone has actually asked something, there is nothing empty about the chat,
 * and waiting for the answer means the whole exchange lives only in memory for
 * as long as the model takes to produce one. A reload in that window used to
 * take the question, the half-written answer and the chat itself, and since no
 * resource had ever been created, the chat could not even be found afterwards.
 */
export const shouldFinalizeDraftChat = (message: AtomicUIMessage) =>
  message.role === 'user';

/**
 * Whether this chat still needs a name.
 *
 * Asked of the resource rather than of `isChatSaved`, which used to stand in
 * for it. Those were the same question only while a chat was saved at the
 * moment it was first titled; now that it is saved a message earlier, a shared
 * flag would report every chat as titled and none would ever get a name.
 */
export const needsTitle = (resource: DraftChatResource) =>
  (resource.get(core.properties.name) ?? DEFAULT_AICHAT_NAME) ===
  DEFAULT_AICHAT_NAME;

export const persistSidebarMessage = async ({
  message,
  newMessages,
  store,
  getOrCreateDraftChatResource,
  isChatSavedRef,
  titlePromiseRef,
  setMessageToResourceMap,
  messageToResourceMapRef,
  setIsChatSaved,
  shouldGenerateTitles,
  generateTitle,
  streaming = false,
}: PersistSidebarMessageArgs) => {
  const resource = await getOrCreateDraftChatResource();

  if (!resource) {
    return;
  }

  const existing = findMessageResource(
    messageToResourceMapRef.current,
    message,
  );

  const messageResource = await upsertMessageInChat(
    message,
    resource,
    store,
    existing,
    {
      saveChat: isChatSavedRef.current && (!streaming || !existing),
      persistToServer: isChatSavedRef.current && (!streaming || !existing),
      commitLoro: streaming && !!existing,
    },
  );

  setMessageToResourceMap(prev => {
    const next = new Map(prev);
    next.set(message, messageResource);
    messageToResourceMapRef.current = next;

    return next;
  });

  if (!isChatSavedRef.current && shouldFinalizeDraftChat(message)) {
    // Persist child messages (and their parts) before the chat resource
    // references them on the server — matches AIChatPage / addMessageToChatResource.
    for (const pendingMessageResource of messageToResourceMapRef.current.values()) {
      await persistMessageResourceToServer(
        pendingMessageResource as Resource<Ai.AiMessage>,
        store,
      );
    }

    await resource.save();

    isChatSavedRef.current = true;
    setIsChatSaved(true);
  }

  // Naming happens on the reply, because a title wants both halves of the
  // exchange to describe. Decided here, where the resource is already in hand,
  // rather than in the component — the caller cannot know whether the chat has
  // been created yet, and a title generated against a chat that does not exist
  // is dropped without a word.
  if (
    !streaming &&
    message.role === 'assistant' &&
    newMessages.length >= 2
  ) {
    if (
      !titlePromiseRef.current &&
      shouldGenerateTitles &&
      needsTitle(resource)
    ) {
      titlePromiseRef.current = generateTitle(newMessages);
    }

    if (titlePromiseRef.current) {
      const name = await titlePromiseRef.current;

      titlePromiseRef.current = undefined;

      if (name) {
        await resource.set(core.properties.name, name);
        await resource.save();
      }
    }
  }
};
