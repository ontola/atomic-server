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
  uiMessageToResource,
  messageResourcesToDisplayMessages,
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
  const [contextItems, setContextItems] = useState<AIMessageContext[]>([]);
  const [messageSubjects, setMessageSubjects] = useArray(
    resource,
    ai.properties.messages,
    {
      commit: true,
    },
  );
  const [messageToResourceMap, setMessageToResourceMap] = useState(
    new Map<AtomicUIMessage, Resource>(),
  );
  const [title, setTitle] = useTitle(resource);

  const canWrite = useCanWrite(resource);
  const { generateTitleFromConversation } = useGenerativeData();

  const addNewMessage = async (message: AtomicUIMessage) => {
    setMessages(prev => [...prev, message]);

    try {
      const messageResource = await uiMessageToResource(
        message,
        resource,
        store,
      );

      resource.push(ai.properties.messages, [messageResource.subject]);

      await resource.save();

      setMessageToResourceMap(prev => {
        prev.set(message, messageResource);

        return prev;
      });
    } catch (error) {
      console.error(error);
      toast.error('Failed to create message resource');
    }
  };

  const handleDeleteMessage = (message: AtomicUIMessage) => {
    const messageResource = messageToResourceMap.get(message);

    if (messageResource) {
      setMessageSubjects(
        messageSubjects.filter(s => s !== messageResource.subject),
      );
      messageResource.destroy();
    }

    setMessages(prev => prev.filter(m => m !== message));

    setMessageToResourceMap(prev => {
      prev.delete(message);

      return prev;
    });
  };

  const removeFollowingMessages = async (message: AtomicUIMessage) => {
    const nextMessages = messages.slice(
      messages.findIndex(x => x.id === message.id) + 1,
    );

    // We need to destroy the resources server side as well as in the internal state.
    // We also need to update the `messages` prop in the chat resource.
    const destroySubjects: string[] = [];

    for (const m of nextMessages) {
      const r = messageToResourceMap.get(m);

      if (r) {
        destroySubjects.push(r.subject);

        try {
          await r.destroy();
        } catch (error) {
          console.error('Error removing message:', error);
        }
      } else {
        throw new Error(`Resource not found for message: ${m.id}`);
      }
    }

    try {
      // Set chat resource on server with new message array
      await resource.set(
        ai.properties.messages,
        resource.props.messages?.filter(x => !destroySubjects.includes(x)),
      );
      await resource.save();
      // Set internal message state
      setMessages(prev => {
        const newMessages = prev.slice(
          0,
          prev.findIndex(x => x.id === message.id) + 1,
        );

        return newMessages;
      });
    } catch (error) {
      console.error('Error removing messages:', error);
    }
  };

  // On load create AIChatDisplayMessages from the resource's messages.
  useEffect(() => {
    messageResourcesToDisplayMessages(messageSubjects, store).then(map => {
      setMessages(Array.from(map.keys()));
      setMessageToResourceMap(map);
      setLoading(false);
    });
  }, []);

  // When there are only two messages and the title is still the default name, generate a title from the conversation.
  useEffect(() => {
    if (
      messages.length === 2 &&
      title === DEFAULT_AICHAT_NAME &&
      shouldGenerateTitles
    ) {
      generateTitleFromConversation(messages).then(setTitle);
    }
  }, [messages, title]);

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <RealAIChat
      fullView
      initialMessages={messages}
      readonly={!canWrite}
      externalContextItems={contextItems}
      setExternalContextItems={setContextItems}
      chatSubject={resource.subject}
      onNewMessage={addNewMessage}
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
