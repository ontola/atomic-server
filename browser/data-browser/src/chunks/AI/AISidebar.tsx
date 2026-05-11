import { styled } from 'styled-components';
import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { newContextItem, useAISidebar } from '@components/AI/AISidebarContext';
import { AIAtomicResourceMessageContext, type AtomicUIMessage } from './types';
import { useCurrentSubject } from '@helpers/useCurrentSubject';
import { FaPlus, FaXmark } from 'react-icons/fa6';
import { IconButton } from '@components/IconButton/IconButton';
import { Row } from '@components/Row';
import {
  ai,
  core,
  useStore,
  type Ai,
  type Resource,
  type Store,
} from '@tomic/react';
import { useGenerativeData } from './useGenerativeData';
import {
  addMessageToChatResource,
  removeFollowingMessagesFromChatResource,
  removeMessageFromChatResource,
} from './chatConversionUtils';
import { RealAIChat } from './RealAIChat';
import { useAISettings } from '@components/AI/AISettingsContext';
import { DEFAULT_AICHAT_NAME } from '@components/AI/aiContstants';
import { useSettings } from '@helpers/AppSettings';
import toast from 'react-hot-toast';

type DraftChatResource = Resource<Ai.AiChat>;
type TitlePromise = Promise<string | undefined>;

type PersistSidebarMessageArgs = {
  message: AtomicUIMessage;
  newMessages: AtomicUIMessage[];
  store: Store;
  getOrCreateDraftChatResource: () => Promise<DraftChatResource | undefined>;
  isChatSavedRef: React.MutableRefObject<boolean>;
  titlePromiseRef: React.MutableRefObject<TitlePromise | undefined>;
  setMessageToResourceMap: React.Dispatch<
    React.SetStateAction<Map<AtomicUIMessage, Resource>>
  >;
  setIsChatSaved: React.Dispatch<React.SetStateAction<boolean>>;
};

const shouldFinalizeDraftChat = (
  newMessages: AtomicUIMessage[],
  message: AtomicUIMessage,
) => newMessages.length >= 2 && message.role === 'assistant';

// This logic was extracted from the component because the logic inside
const persistSidebarMessage = async ({
  message,
  newMessages,
  store,
  getOrCreateDraftChatResource,
  isChatSavedRef,
  titlePromiseRef,
  setMessageToResourceMap,
  setIsChatSaved,
}: PersistSidebarMessageArgs) => {
  const resource = await getOrCreateDraftChatResource();

  if (!resource) {
    return;
  }

  const messageResource = await addMessageToChatResource(
    message,
    resource,
    store,
    { saveChat: isChatSavedRef.current },
  );

  setMessageToResourceMap(prev => {
    const next = new Map(prev);
    next.set(message, messageResource);

    return next;
  });

  // The sidebar chat stays as an unsaved draft until there is a real
  // user/assistant exchange, avoiding empty chat resources.
  if (shouldFinalizeDraftChat(newMessages, message)) {
    if (titlePromiseRef.current) {
      const name = await titlePromiseRef.current;

      if (name) {
        await resource.set(core.properties.name, name);
      }

      titlePromiseRef.current = undefined;
    }

    if (!isChatSavedRef.current) {
      await resource.save();
      isChatSavedRef.current = true;
      setIsChatSaved(true);
    }
  }
};

const handleSidebarMessageSaveError = (error: unknown) => {
  console.error(error);
  toast.error('Failed to save AI chat message');
};

const AISidebar: React.FC = () => {
  const store = useStore();
  const [rerenderKey, updateRenderKey] = useReducer(prev => prev + 1, 0);
  const { shouldGenerateTitles } = useAISettings();
  const { isOpen, contextItems, setContextItems, setIsOpen } = useAISidebar();
  const { drive } = useSettings();
  const [messages, setMessages] = useState<AtomicUIMessage[]>([]);
  // The chat callbacks can fire before React has committed the latest state, so
  // keep mutable mirrors for values that async persistence logic must read.
  const messagesRef = useRef<AtomicUIMessage[]>([]);
  const [chatResource, setChatResource] = useState<Resource<Ai.AiChat>>();
  const chatResourceRef = useRef<Resource<Ai.AiChat> | undefined>(undefined);
  const [isChatSaved, setIsChatSaved] = useState(false);
  const isChatSavedRef = useRef(false);
  // Draft creation is shared by "sidebar opened" and "first message added".
  // Store the in-flight promise so both paths use the same resource.
  const draftChatPromiseRef = useRef<Promise<
    Resource<Ai.AiChat>
  > | null>(null);
  // Incremented when starting a new chat to ignore stale async resource
  // creation from the previous conversation.
  const chatGenerationRef = useRef(0);
  const [messageToResourceMap, setMessageToResourceMap] = useState(
    new Map<AtomicUIMessage, Resource>(),
  );
  const [currentSubject] = useCurrentSubject();
  const titlePromiseRef = useRef<TitlePromise | undefined>(undefined);
  const autoContextSubjectRef = useRef<string | undefined>(undefined);
  const { generateTitleFromConversation } = useGenerativeData();

  const getOrCreateDraftChatResource = useCallback(async () => {
    if (chatResourceRef.current) {
      return chatResourceRef.current;
    }

    const generation = chatGenerationRef.current;

    if (!draftChatPromiseRef.current) {
      draftChatPromiseRef.current = store.newResource<Ai.AiChat>({
        parent: drive,
        isA: ai.classes.aiChat,
        propVals: {
          [core.properties.name]: DEFAULT_AICHAT_NAME,
        },
      });
    }

    const draftChatPromise = draftChatPromiseRef.current;
    const newChatResource = await draftChatPromise;

    if (draftChatPromiseRef.current === draftChatPromise) {
      draftChatPromiseRef.current = null;
    }

    if (generation !== chatGenerationRef.current) {
      return undefined;
    }

    chatResourceRef.current = newChatResource;
    setChatResource(newChatResource);

    return newChatResource;
  }, [drive, store]);

  const addNewMessage = (message: AtomicUIMessage) => {
    const newMessages = [...messagesRef.current, message];

    messagesRef.current = newMessages;
    setMessages(newMessages);

    // Start title generation as soon as the first assistant response completes,
    // but save the resource even when title generation is disabled or fails.
    if (
      !isChatSavedRef.current &&
      !titlePromiseRef.current &&
      newMessages.length >= 2 &&
      message.role === 'assistant'
    ) {
      titlePromiseRef.current = shouldGenerateTitles
        ? generateTitleFromConversation(newMessages)
        : Promise.resolve(undefined);
    }

    persistSidebarMessage({
      message,
      newMessages,
      store,
      getOrCreateDraftChatResource,
      isChatSavedRef,
      titlePromiseRef,
      setMessageToResourceMap,
      setIsChatSaved,
    }).catch(handleSidebarMessageSaveError);
  };

  const handleMessageDelete = async (message: AtomicUIMessage) => {
    const messageResource = messageToResourceMap.get(message);

    if (chatResource && messageResource) {
      try {
        await removeMessageFromChatResource(
          messageResource,
          chatResource,
          { saveChat: isChatSavedRef.current },
        );
      } catch (error) {
        console.error('Error removing message:', error);
        toast.error('Failed to remove AI chat message');
      }
    }

    setMessageToResourceMap(prev => {
      const next = new Map(prev);
      next.delete(message);

      return next;
    });

    const nextMessages = messagesRef.current.filter(m => m !== message);
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
  };

  const startNewChat = () => {
    chatGenerationRef.current += 1;
    draftChatPromiseRef.current = null;
    chatResourceRef.current = undefined;
    setChatResource(undefined);
    isChatSavedRef.current = false;
    setIsChatSaved(false);
    setMessages([]);
    messagesRef.current = [];
    setMessageToResourceMap(new Map());
    titlePromiseRef.current = undefined;
    autoContextSubjectRef.current = undefined;
    setContextItems([]);
    updateRenderKey();

    if (isOpen) {
      void getOrCreateDraftChatResource();
    }
  };

  const onRegenerateMessage = async (message: AtomicUIMessage) => {
    if (chatResource) {
      try {
        const trimmedMessages = await removeFollowingMessagesFromChatResource(
          message,
          messages,
          messageToResourceMap,
          chatResource,
          { saveChat: isChatSavedRef.current },
        );

        setMessageToResourceMap(prev => {
          const next = new Map(prev);

          for (const m of messages.slice(trimmedMessages.length)) {
            next.delete(m);
          }

          return next;
        });

        messagesRef.current = trimmedMessages;
        setMessages(trimmedMessages);
        titlePromiseRef.current = undefined;
      } catch (error) {
        console.error('Error removing messages:', error);
        toast.error('Failed to regenerate AI chat message');
      }

      return;
    }

    // Remove all messages after the one that was regenerated
    const trimmedMessages = messages.slice(
      0,
      messages.findIndex(x => x.id === message.id) + 1,
    );

    messagesRef.current = trimmedMessages;
    setMessages(trimmedMessages);
    titlePromiseRef.current = undefined;
  };

  useEffect(() => {
    if (isOpen) {
      void getOrCreateDraftChatResource();
    }
  }, [isOpen, getOrCreateDraftChatResource]);

  useEffect(() => {
    // Avoid re-adding the same subject after the user removes or changes the
    // auto-inserted context item.
    // When the user opens the AI sidebar and the chat is completely empty, we add the current subject to the context.
    if (
      isOpen &&
      currentSubject &&
      messages.length === 0 &&
      contextItems.length < 2 &&
      autoContextSubjectRef.current !== currentSubject
    ) {
      autoContextSubjectRef.current = currentSubject;
      setContextItems([
        newContextItem<AIAtomicResourceMessageContext>({
          type: 'atomic-resource',
          subject: currentSubject,
        }),
      ]);
    }
  }, [
    isOpen,
    currentSubject,
    messages.length,
    contextItems.length,
    setContextItems,
  ]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  return (
    <React.Fragment key={rerenderKey}>
      {/* When resetting the chat it is better to refresh the whole component because the useChat hook keeps internal state that is not easy to reset. */}
      <RealAIChat
        initialMessages={messages}
        onNewMessage={addNewMessage}
        externalContextItems={contextItems}
        setExternalContextItems={setContextItems}
        chatSubject={isChatSaved ? chatResource?.subject : undefined}
        onDeleteMessage={handleMessageDelete}
        onRegenerateMessage={onRegenerateMessage}
      >
        <Row center justify='space-between' fullWidth>
          <Row center gap='0.5ch'>
            <IconButton
              title='New Chat'
              onClick={startNewChat}
              color='textLight'
              style={{ alignSelf: 'flex-end' }}
            >
              <FaPlus />
            </IconButton>
            <Heading>Atomic Assistant</Heading>
          </Row>
          <Row center gap='0.5ch'>
            <IconButton
              title='Close AI Sidebar'
              color='textLight'
              style={{ alignSelf: 'flex-end' }}
              onClick={() => {
                setIsOpen(false);
              }}
            >
              <FaXmark />
            </IconButton>
          </Row>
        </Row>
      </RealAIChat>
    </React.Fragment>
  );
};

const Heading = styled.h2`
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: ${p => p.theme.size(2)};
`;

export default AISidebar;
