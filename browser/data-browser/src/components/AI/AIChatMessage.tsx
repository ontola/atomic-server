import styled from 'styled-components';
import { FaRetweet, FaTrash } from 'react-icons/fa6';
import { type AtomicUIMessage } from './types';
import { AssistantMessage } from './AIChatMessageParts/AssistantMessage';
import { IconButton } from '../IconButton/IconButton';
import { UserMessage } from './AIChatMessageParts/UserMessage';

interface MessageProps {
  message: AtomicUIMessage;
  onDeleteMessage?: (message: AtomicUIMessage) => void;
  onRegenerateMessage?: (message: AtomicUIMessage) => void;
}

export const AIChatMessage = ({
  message,
  onDeleteMessage,
  onRegenerateMessage,
}: MessageProps) => {
  if (message.role === 'user') {
    return (
      <MessageActionWrapper
        message={message}
        onDeleteMessage={onDeleteMessage}
        onRegenerateMessage={onRegenerateMessage}
      >
        <UserMessage message={message} />
      </MessageActionWrapper>
    );
  }

  if (message.role === 'assistant') {
    return (
      <MessageActionWrapper message={message} onDeleteMessage={onDeleteMessage}>
        <AssistantMessage message={message} />
      </MessageActionWrapper>
    );
  }

  return <span>Unknown message type</span>;
};

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
