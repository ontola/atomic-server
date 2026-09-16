import { type AtomicUIMessage } from '../types';
import { styled } from 'styled-components';
import Markdown from '@components/datatypes/Markdown';
import { Row } from '@components/Row';
import { MessageContextItem } from '../MessageContextItem';
import { FileContent } from './FileContent';

interface UserMessageProps {
  message: AtomicUIMessage;
}

export const UserMessage: React.FC<UserMessageProps> = ({ message }) => {
  const context = message.metadata?.userContext;
  const visibleContext = context?.filter(item => item.type !== 'skill');

  return (
    <UserMessageWrapper>
      <SenderName>You</SenderName>
      {visibleContext && visibleContext.length > 0 && (
        <ContextItemRow wrapItems center gap='1ch'>
          {visibleContext.map(item => (
            <MessageContextItem key={item.id} contextItem={item} />
          ))}
        </ContextItemRow>
      )}
      {message.parts.map((part, index) => {
        if (part.type === 'text') {
          return <Markdown key={index} text={part.text} maxLength={Infinity} />;
        } else if (part.type === 'file') {
          return <FileContent key={index} part={part} />;
        } else {
          return null; // Handle other part types if needed
        }
      })}
    </UserMessageWrapper>
  );
};

const ContextItemRow = styled(Row)`
  margin-block-end: var(--space-2);
`;

const MessageWrapper = styled.div`
  border-radius: var(--radius-md);
  width: 90%;
  padding-block: var(--space-3);

  &:hover {
    background-color: var(--color-bg);
  }
`;

const UserMessageWrapper = styled(MessageWrapper)`
  padding: var(--space-3);
  background-color: var(--color-bg);
  align-self: flex-end;
  border: solid 1px var(--color-border);
`;

const SenderName = styled.span`
  font-weight: bold;
  color: var(--color-text-subtle);
  font-size: 0.8rem;
  margin-bottom: 0.5rem;
  display: block;
`;
