import { styled } from 'styled-components';
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { newContextItem, useAISidebar } from '@components/AI/AISidebarContext';
import { AIAtomicResourceMessageContext, type AtomicUIMessage } from './types';
import { useCurrentSubject } from '@helpers/useCurrentSubject';
import { FaArrowRotateLeft, FaFloppyDisk, FaXmark } from 'react-icons/fa6';
import { IconButton } from '@components/IconButton/IconButton';
import { Row } from '@components/Row';
import { ParentPickerDialog } from '@components/ParentPicker/ParentPickerDialog';
import { ai, core, useStore, type Ai } from '@tomic/react';
import { useGenerativeData } from './useGenerativeData';
import { uiMessageToResource } from './chatConversionUtils';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { constructOpenURL } from '@helpers/navigation';
import { RealAIChat } from './RealAIChat';
import { useAISettings } from '@components/AI/AISettingsContext';

const AISidebar: React.FC = () => {
  const store = useStore();
  const [rerenderKey, updateRenderKey] = useReducer(prev => prev + 1, 0);
  const { shouldGenerateTitles } = useAISettings();
  const { isOpen, contextItems, setContextItems, setIsOpen } = useAISidebar();
  const [messages, setMessages] = useState<AtomicUIMessage[]>([]);
  const [currentSubject] = useCurrentSubject();
  const [showParentPicker, setShowParentPicker] = useState(false);
  const titlePromiseRef = useRef<Promise<string | undefined> | undefined>(
    undefined,
  );
  const { generateTitleFromConversation } = useGenerativeData();
  const navigate = useNavigateWithTransition();

  const addNewMessage = (message: AtomicUIMessage) => {
    setMessages(prev => [...prev, message]);
  };

  const handleParentSelect = async (parent: string) => {
    const chatResource = await store.newResource<Ai.AiChat>({
      parent,
      isA: ai.classes.aiChat,
      propVals: {
        [core.properties.name]: 'New Chat',
      },
    });

    for (const message of messages) {
      const messageResource = await uiMessageToResource(
        message,
        chatResource,
        store,
      );

      chatResource.push(ai.properties.messages, [messageResource.subject]);
      messageResource.save();
    }

    if (titlePromiseRef.current) {
      const name = await titlePromiseRef.current;

      if (name) {
        await chatResource.set(core.properties.name, name);
      }

      titlePromiseRef.current = undefined;
    }

    await chatResource.save();

    store.notifyResourceManuallyCreated(chatResource);

    setMessages([]);
    navigate(constructOpenURL(chatResource.subject));
  };

  const handleMessageDelete = (message: AtomicUIMessage) => {
    setMessages(prev => prev.filter(m => m !== message));
  };

  const resetChat = () => {
    setMessages([]);
    updateRenderKey();
  };

  const onRegenerateMessage = (message: AtomicUIMessage) => {
    // Remove all messages after the one that was regenerated
    setMessages(prev => {
      const index = prev.findIndex(m => m.id === message.id);

      return prev.slice(0, index + 1);
    });
  };

  useEffect(() => {
    // When the user opens the AI sidebar and the chat is completely empty, we add the current subject to the context.
    if (
      isOpen &&
      currentSubject &&
      messages.length === 0 &&
      contextItems.length < 2
    ) {
      setContextItems([
        newContextItem<AIAtomicResourceMessageContext>({
          type: 'atomic-resource',
          subject: currentSubject,
        }),
      ]);
    }
  }, [isOpen, currentSubject]);

  useEffect(() => {
    if (messages.length > 2 && !titlePromiseRef.current) {
      if (!shouldGenerateTitles) {
        // Don't generate a title, just resolve the promise.
        titlePromiseRef.current = Promise.resolve(undefined);

        return;
      }

      titlePromiseRef.current = generateTitleFromConversation(messages);
    }
  }, [messages]);

  return (
    <React.Fragment key={rerenderKey}>
      {/* When resetting the chat it is better to refresh the whole component because the useChat hook keeps internal state that is not easy to reset. */}
      <RealAIChat
        initialMessages={messages}
        onNewMessage={addNewMessage}
        externalContextItems={contextItems}
        setExternalContextItems={setContextItems}
        onDeleteMessage={handleMessageDelete}
        onRegenerateMessage={onRegenerateMessage}
      >
        <Row center justify='space-between' fullWidth>
          <Row center gap='0.5ch'>
            <IconButton
              title='Reset'
              onClick={resetChat}
              color='textLight'
              style={{ alignSelf: 'flex-end' }}
            >
              <FaArrowRotateLeft />
            </IconButton>
            <Heading>Atomic Assistant</Heading>
          </Row>
          <Row center gap='0.5ch'>
            <IconButton
              title='Save Chat'
              onClick={() => setShowParentPicker(true)}
              disabled={messages.length < 2}
              color='textLight'
              style={{ alignSelf: 'flex-end' }}
            >
              <FaFloppyDisk />
            </IconButton>
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
      <ParentPickerDialog
        open={showParentPicker}
        onOpenChange={setShowParentPicker}
        onSelect={handleParentSelect}
      />
    </React.Fragment>
  );
};

const Heading = styled.h2`
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: ${p => p.theme.size(2)};
`;

export default AISidebar;
