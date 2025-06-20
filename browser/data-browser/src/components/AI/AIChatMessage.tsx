import styled from 'styled-components';
import Markdown from '../datatypes/Markdown';
import type { CoreAssistantMessage, CoreToolMessage } from 'ai';
import { FaCircleExclamation, FaRetweet, FaTrash } from 'react-icons/fa6';
import {
  isAIErrorMessage,
  isMessageWithContext,
  type AIChatDisplayMessage,
} from './types';
import { UserMessage, ToolResultMessage } from './AIChatMessageParts';
import { AssistantMessage } from './AIChatMessageParts/AssistantMessage';
import { IconButton } from '../IconButton/IconButton';

interface MessageProps {
  message: AIChatDisplayMessage;
  onDeleteMessage?: (message: AIChatDisplayMessage) => void;
  onRegenerateMessage?: (message: AIChatDisplayMessage) => void;
}

function isToolMessage(
  message: AIChatDisplayMessage,
): message is CoreToolMessage {
  return message.role === 'tool';
}

function isAssistantMessage(
  message: AIChatDisplayMessage,
): message is CoreAssistantMessage {
  return message.role === 'assistant';
}

export const AIChatMessage = ({
  message: messageIn,
  onDeleteMessage,
  onRegenerateMessage,
}: MessageProps) => {
  const [message, context] = isMessageWithContext(messageIn)
    ? [messageIn.message, messageIn.context]
    : [messageIn];

  if (message.role === 'user') {
    return (
      <MessageActionWrapper
        message={message}
        onDeleteMessage={onDeleteMessage}
        onRegenerateMessage={onRegenerateMessage}
      >
        <UserMessage message={message} context={context} />
      </MessageActionWrapper>
    );
  }

  if (isAIErrorMessage(message)) {
    return (
      <ErrorMessageWrapper>
        <SenderName>
          <FaCircleExclamation />
          Error
        </SenderName>
        <Markdown text={message.content} maxLength={Infinity} />
      </ErrorMessageWrapper>
    );
  }

  if (isToolMessage(message)) {
    return <ToolResultMessage message={message} />;
  }

  if (isAssistantMessage(message)) {
    return (
      <MessageActionWrapper message={message} onDeleteMessage={onDeleteMessage}>
        <AssistantMessage message={message} />
      </MessageActionWrapper>
    );
  }

  return <span>Unknown message type</span>;
};

const ErrorMessageWrapper = styled.div`
  border-radius: ${p => p.theme.radius};
  width: 90%;
  padding: ${p => p.theme.size()};

  background-color: ${p => (p.theme.darkMode ? '#440e0e' : '#f8dbdb')};
`;

const SenderName = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  font-weight: bold;
  font-size: 0.6rem;
  color: ${p => p.theme.colors.textLight};
  svg {
    font-size: 0.8rem;
    color: ${p => p.theme.colors.textLight};
  }
`;

const FloatingActionRow = styled.div`
  position: absolute;
  top: 0;
  right: 0;

  display: none;
`;

const MessageTopWrapper = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;

  &:hover {
    ${FloatingActionRow} {
      display: block;
    }
  }
`;

const MessageActionWrapper: React.FC<React.PropsWithChildren<MessageProps>> = ({
  children,
  message,
  onDeleteMessage,
  onRegenerateMessage,
}) => {
  return (
    <MessageTopWrapper>
      <FloatingActionRow>
        {onDeleteMessage && (
          <IconButton
            color='textLight'
            onClick={() => onDeleteMessage(message)}
            title='Delete Message'
          >
            <FaTrash />
          </IconButton>
        )}
        {onRegenerateMessage && (
          <IconButton
            color='textLight'
            onClick={() => onRegenerateMessage(message)}
            title='Regenerate response'
          >
            <FaRetweet />
          </IconButton>
        )}
      </FloatingActionRow>
      {children}
    </MessageTopWrapper>
  );
};
