import type { CoreUserMessage, FilePart } from 'ai';
import { type AIResourceMessageContext } from '../types';
import { styled } from 'styled-components';
import { FaFile } from 'react-icons/fa6';
import Markdown from '../../datatypes/Markdown';
import { Row } from '../../Row';
import { MessageContextItem } from '../MessageContextItem';
import { ImageContent, isImagePart } from './ImageContent';

interface UserMessageProps {
  message: CoreUserMessage;
  context?: AIResourceMessageContext[];
}

function isFilePart(part: unknown): part is FilePart {
  return (
    !!part && typeof part === 'object' && 'type' in part && part.type === 'file'
  );
}

export const UserMessage: React.FC<UserMessageProps> = ({
  message,
  context,
}) => {
  return (
    <UserMessageWrapper>
      <SenderName>You</SenderName>
      {context && (
        <ContextItemRow wrapItems center gap='1ch'>
          {context.map(item => (
            <MessageContextItem key={item.id} contextItem={item} />
          ))}
        </ContextItemRow>
      )}
      {typeof message.content === 'string' ? (
        <RenderUserContent text={message.content} />
      ) : Array.isArray(message.content) ? (
        <>
          {message.content.map((part, index) => {
            if (typeof part === 'string') {
              return <RenderUserContent key={index} text={part} />;
            } else if (isImagePart(part)) {
              return <ImageContent key={index} imagePart={part} />;
            } else if (isFilePart(part)) {
              return <FileContent key={index} />;
            } else if (part.type === 'text') {
              return (
                <Markdown key={index} text={part.text} maxLength={Infinity} />
              );
            } else {
              return null; // Handle other part types if needed
            }
          })}
        </>
      ) : null}
    </UserMessageWrapper>
  );
};

const RenderUserContent = ({ text }: { text: string }) => {
  const extractedText = text.match(/<context>([\s\S]*?)<\/context>/);

  if (extractedText) {
    return <Markdown text={text.replace(extractedText[0], '').trim()} />;
  }

  return <Markdown text={text} maxLength={Infinity} />;
};

const ContextItemRow = styled(Row)`
  margin-block-end: ${p => p.theme.size(2)};
`;

const FileContent = () => {
  // Display filename/title based on what's available
  // FilePart has data and mimeType properties
  return (
    <MessageFileWrapper>
      <FaFile />
      Attached File
    </MessageFileWrapper>
  );
};

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

const SenderName = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  font-weight: bold;
  font-size: 0.6rem;
  color: ${p => p.theme.colors.textLight};
`;

const MessageFileWrapper = styled.div`
  margin: ${p => p.theme.size(1)} 0;

  background-color: ${p => p.theme.colors.bg1};
  padding: ${p => p.theme.size(1)};
  border-radius: ${p => p.theme.radius};
`;
