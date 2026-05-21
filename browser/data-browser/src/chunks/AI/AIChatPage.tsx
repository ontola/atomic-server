import { useEffect, useState } from 'react';
import {
  Ai,
  ai,
  useArray,
  useCanWrite,
  useStore,
  useTitle,
  type Resource,
} from '@tomic/react';
import type { ResourcePageProps } from '@views/ResourcePage';
import toast from 'react-hot-toast';
import { type AIMessageContext, type AtomicUIMessage } from './types';
import { Column, Row } from '@components/Row';
import { EditableTitle } from '@components/EditableTitle';
import { DEFAULT_AICHAT_NAME } from '@components/AI/aiContstants';
import { useGenerativeData } from './useGenerativeData';
import {
  addMessageToChatResource,
  messageResourcesToDisplayMessages,
  removeFollowingMessagesFromChatResource,
  removeMessageFromChatResource,
} from './chatConversionUtils';
import { TagBar } from '@components/Tag/TagBar';
import { RealAIChat } from './RealAIChat';
import { useAISettings } from '@components/AI/AISettingsContext';
import { styled } from 'styled-components';

const AIChatPage: React.FC<ResourcePageProps<Ai.AiChat>> = ({ resource }) => {
  const store = useStore();
  const { shouldGenerateTitles } = useAISettings();
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<AtomicUIMessage[]>([]);
  const [compactedMessages, setCompactedMessages] = useState<AtomicUIMessage[]>(
    [],
  );
  const [contextItems, setContextItems] = useState<AIMessageContext[]>([]);
  const [messageSubjects] = useArray(resource, ai.properties.messages);
  const [messageToResourceMap, setMessageToResourceMap] = useState(
    new Map<AtomicUIMessage, Resource>(),
  );
  const [title, setTitle] = useTitle(resource);

  const canWrite = useCanWrite(resource);
  const { generateTitleFromConversation } = useGenerativeData();

  const addNewMessage = async (message: AtomicUIMessage) => {
    setMessages(prev => [...prev, message]);

    const newMessages = [...messages, message];

    // When there are only two messages and the title is still the default name, generate a title from the conversation.
    if (
      newMessages.length === 2 &&
      title === DEFAULT_AICHAT_NAME &&
      shouldGenerateTitles
    ) {
      generateTitleFromConversation(newMessages).then(setTitle);
    }

    try {
      const messageResource = await addMessageToChatResource(
        message,
        resource,
        store,
      );

      setMessageToResourceMap(prev => {
        const next = new Map(prev);
        next.set(message, messageResource);

        return next;
      });
    } catch (error) {
      console.error(error);
      toast.error('Failed to create message resource');
    }
  };

  const handleSummaryDeleted = (restored: AtomicUIMessage[]) => {
    setCompactedMessages([]);
    setMessages(restored);
  };

  const handleDeleteMessage = async (message: AtomicUIMessage) => {
    const messageResource = messageToResourceMap.get(message);

    if (messageResource) {
      try {
        await removeMessageFromChatResource(messageResource, resource);
      } catch (error) {
        console.error('Error removing message:', error);
        toast.error('Failed to remove message resource');
      }
    }

    setMessageToResourceMap(prev => {
      const next = new Map(prev);
      next.delete(message);

      return next;
    });

    if (message.metadata?.isSummary) {
      return;
    }

    setMessages(prev => prev.filter(m => m !== message));
  };

  const handleCompacted = async (
    priorMessages: AtomicUIMessage[],
    summaryMessage: AtomicUIMessage,
  ) => {
    setCompactedMessages(prev => [...prev, ...priorMessages]);
    setMessages([summaryMessage]);

    try {
      const messageResource = await addMessageToChatResource(
        summaryMessage,
        resource,
        store,
      );

      setMessageToResourceMap(prev => {
        const next = new Map(prev);
        next.set(summaryMessage, messageResource);

        return next;
      });
    } catch (error) {
      console.error(error);
      toast.error('Failed to save summary message');
    }
  };

  const removeFollowingMessages = async (message: AtomicUIMessage) => {
    const isHistorical = compactedMessages.some(m => m.id === message.id);
    const allMessages = isHistorical
      ? [...compactedMessages, ...messages]
      : messages;

    try {
      const newMessages = await removeFollowingMessagesFromChatResource(
        message,
        allMessages,
        messageToResourceMap,
        resource,
      );

      setMessageToResourceMap(prev => {
        const next = new Map(prev);

        for (const m of allMessages.slice(newMessages.length)) {
          next.delete(m);
        }

        return next;
      });

      if (isHistorical) {
        setCompactedMessages([]);
      }

      setMessages(newMessages);
    } catch (error) {
      console.error('Error removing messages:', error);
    }
  };

  // On load create AIChatDisplayMessages from the resource's messages.
  useEffect(() => {
    messageResourcesToDisplayMessages(messageSubjects, store).then(map => {
      const allMessages = Array.from(map.keys());
      const lastSummaryIndex = allMessages.findLastIndex(
        m => m.metadata?.isSummary,
      );

      if (lastSummaryIndex > 0) {
        setCompactedMessages(allMessages.slice(0, lastSummaryIndex));
        setMessages(allMessages.slice(lastSummaryIndex));
      } else {
        setMessages(allMessages);
      }

      setMessageToResourceMap(map);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <RealAIChat
      fullView
      initialMessages={messages}
      historicalMessages={compactedMessages}
      readonly={!canWrite}
      externalContextItems={contextItems}
      setExternalContextItems={setContextItems}
      chatSubject={resource.subject}
      onNewMessage={addNewMessage}
      onCompacted={handleCompacted}
      onSummaryDeleted={handleSummaryDeleted}
      onDeleteMessage={handleDeleteMessage}
      onRegenerateMessage={removeFollowingMessages}
    >
      <Column gap='0.5rem'>
        <Row>
          <SmallTitle resource={resource} />
        </Row>
        <TagBar resource={resource} />
      </Column>
    </RealAIChat>
  );
};

export default AIChatPage;

const SmallTitle = styled(EditableTitle)`
  font-size: 1rem;
`;
