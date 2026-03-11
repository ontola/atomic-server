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
  const context = message.metadata?.context;

  return (
    <UserMessageWrapper>
      {context && (
        <ContextItemRow wrapItems center gap='1ch'>
          {context.map(item => (
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
  margin-block-end: ${p => p.theme.size(2)};
`;

const MessageWrapper = styled.div`
  border-radius: ${p => p.theme.radius};
  width: 90%;
  padding-block: ${p => p.theme.size()};

  &:hover {
    background-color: ${p => p.theme.colors.bg};
  }
`;

const UserMessageWrapper = styled(MessageWrapper)`
  padding: ${p => p.theme.size()};
  background-color: ${p => p.theme.colors.bg};
  align-self: flex-end;
  box-shadow: ${p => p.theme.boxShadow};
`;
