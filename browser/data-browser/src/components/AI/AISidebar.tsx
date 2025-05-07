import { styled } from 'styled-components';
import { SimpleAIChat } from './SimpleAIChat';
import React, { useEffect, useState } from 'react';
import { newContextItem, useAISidebar } from './AISidebarContext';
import type { AIChatDisplayMessage } from './types';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import { FaPlus, FaXmark } from 'react-icons/fa6';
import { IconButton } from '../IconButton/IconButton';
import { Row } from '../Row';

export const AISidebar: React.FC = () => {
  const { isOpen, contextItems, setContextItems, setIsOpen } = useAISidebar();
  const [messages, setMessages] = useState<AIChatDisplayMessage[]>([]);
  const [currentSubject] = useCurrentSubject();

  const addNewMessage = (message: AIChatDisplayMessage) => {
    setMessages(prev => [...prev, message]);
  };

  useEffect(() => {
    // When the user opens the AI sidebar and the chat is completely empty, we add the current subject to the context.
    if (
      isOpen &&
      currentSubject &&
      messages.length === 0 &&
      // userInput.length === 0 &&
      contextItems.length === 0
    ) {
      setContextItems([
        newContextItem({
          type: 'resource',
          subject: currentSubject,
        }),
      ]);
    }
  }, [isOpen, currentSubject]);

  return (
    <SidebarContainer data-open={isOpen ? '' : undefined}>
      <SimpleAIChat
        messages={messages}
        onNewMessage={addNewMessage}
        externalContextItems={contextItems}
        setExternalContextItems={setContextItems}
      >
        <Row center justify='space-between' fullWidth>
          <Row center gap='1ch'>
            <IconButton
              title='Reset'
              onClick={() => setMessages([])}
              color='textLight'
              style={{ alignSelf: 'flex-end' }}
            >
              <FaPlus />
            </IconButton>
            <Heading>Atomic Assistant</Heading>
          </Row>
          <IconButton
            title='Close AI Sidebar'
            color='textLight'
            style={{ alignSelf: 'flex-end' }}
            onClick={() => {
              // abortSignalRef.current?.abort();
              setIsOpen(false);
            }}
          >
            <FaXmark />
          </IconButton>
        </Row>
      </SimpleAIChat>
    </SidebarContainer>
  );
};

const SidebarContainer = styled.div`
  background-color: ${p => p.theme.colors.bg};
  display: none;
  transform: translateX(30rem);
  width: min(30rem, 100vw);
  overflow: hidden;
  border-left: 1px solid ${p => p.theme.colors.bg2};
  padding: ${p => p.theme.size()};
  padding-top: 2px;
  transition:
    display 100ms allow-discrete,
    transform 100ms ease-in-out;

  &[data-open] {
    transform: translateX(0rem);
    display: block;
  }

  @starting-style {
    transform: translateX(30rem);
    display: none;
  }
`;

const Heading = styled.h2`
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: ${p => p.theme.size(2)};
`;
