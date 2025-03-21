import { useEffect, useState } from 'react';
import { SimpleAIChat } from '../../components/AI/SimpleAIChat';
import { ai, useArray, useCanWrite, useStore, useTitle } from '@tomic/react';
import type { ResourcePageProps } from '../ResourcePage';
import toast from 'react-hot-toast';
import {
  type AIChatDisplayMessage,
  type AIMessageContext,
} from '../../components/AI/types';
import { Row } from '../../components/Row';
import { EditableTitle } from '../../components/EditableTitle';
import { DEFAULT_AICHAT_NAME } from '../../components/AI/aiContstants';
import { useGenerativeData } from '../../components/AI/useGenerativeData';
import {
  displayMessageToResource,
  messageResourcesToDisplayMessages,
} from '../../components/AI/chatConversionUtils';

export const AIChatPage: React.FC<ResourcePageProps> = ({ resource }) => {
  const store = useStore();
  const [messages, setMessages] = useState<AIChatDisplayMessage[]>([]);
  const [contextItems, setContextItems] = useState<AIMessageContext[]>([]);
  const [messageSubjects] = useArray(resource, ai.properties.messages, {
    commit: true,
  });
  const [title, setTitle] = useTitle(resource);

  const canWrite = useCanWrite(resource);
  const { generateTitleFromConversation } = useGenerativeData();

  const addNewMessage = async (message: AIChatDisplayMessage) => {
    setMessages(prev => [...prev, message]);

    try {
      const messageResource = await displayMessageToResource(
        message,
        resource,
        store,
      );
      resource.push(ai.properties.messages, [messageResource.subject]);
      await resource.save();
    } catch (error) {
      console.error(error);
      toast.error('Failed to create message resource');
    }
  };

  // On load create AIChatDisplayMessages from the resource's messages.
  useEffect(() => {
    messageResourcesToDisplayMessages(messageSubjects, store).then(setMessages);
  }, []);

  useEffect(() => {
    if (messages.length === 2 && title === DEFAULT_AICHAT_NAME) {
      generateTitleFromConversation(messages).then(setTitle);
    }
  }, [messages, title]);

  return (
    <SimpleAIChat
      fullView
      messages={messages}
      onNewMessage={addNewMessage}
      readonly={!canWrite}
      externalContextItems={contextItems}
      setExternalContextItems={setContextItems}
    >
      <Row>
        <EditableTitle resource={resource} />
      </Row>
    </SimpleAIChat>
  );
};
