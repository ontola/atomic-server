import styled from 'styled-components';
import Markdown from '../datatypes/Markdown';
import { Details } from '../Details';
import type {
  CoreAssistantMessage,
  CoreMessage,
  CoreToolMessage,
  FilePart,
  ImagePart,
  ToolCallPart,
  ToolResultPart,
} from 'ai';
import {
  FaCircleExclamation,
  FaFile,
  FaMagnifyingGlass,
  FaPencil,
} from 'react-icons/fa6';
import { Row } from '../Row';
import { ResourceInline } from '../../views/ResourceInline';
import { TOOL_NAMES } from './useAtomicTools';
import { useResource, useResources } from '@tomic/react';
import {
  isAIErrorMessage,
  isMessageWithContext,
  type AIChatDisplayMessage,
} from './types';
import { MessageContextItem } from './MessageContextItem';

interface MessageProps {
  message: AIChatDisplayMessage;
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

function isImagePart(part: unknown): part is ImagePart {
  return (
    !!part &&
    typeof part === 'object' &&
    'type' in part &&
    part.type === 'image'
  );
}

function isFilePart(part: unknown): part is FilePart {
  return (
    !!part && typeof part === 'object' && 'type' in part && part.type === 'file'
  );
}

export const AIChatMessage = ({ message: messageIn }: MessageProps) => {
  const message = isMessageWithContext(messageIn)
    ? messageIn.message
    : messageIn;

  if (message.role === 'user') {
    return (
      <UserMessageWrapper>
        <SenderName>You</SenderName>
        {isMessageWithContext(messageIn) && (
          <ContextItemRow wrapItems center gap='1ch'>
            {messageIn.context.map(item => (
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
    return message.content.map(c => {
      const key = `result-${c.toolCallId}`;

      if (c.toolName === TOOL_NAMES.SEARCH_RESOURCE) {
        return <SearchResultMessage toolResultPart={c} key={key} />;
      }

      if (c.toolName === TOOL_NAMES.SHOW_SVG) {
        console.log(c.result);

        return (
          <div key={key} dangerouslySetInnerHTML={{ __html: c.result.data }} />
        );
      }

      let result;

      if (typeof c.result === 'string') {
        result = c.result;
      } else {
        result = JSON.stringify(c.result, null, 2);
      }

      return (
        <div key={key}>
          <Details title='Result'>
            <StyledPre>
              <code>{result}</code>
            </StyledPre>
          </Details>
        </div>
      );
    });
  }

  if (isAssistantMessage(message)) {
    if (message.content.length === 0) {
      return null;
    }

    if (typeof message.content === 'string') {
      return <BasicMessage text={message.content} />;
    }

    return (
      <>
        {message.content.map((c, index) => {
          if (c.type === 'text') {
            if (c.text.length === 0) {
              return null;
            }

            return <BasicMessage key={`text-${index}`} text={c.text} />;
          }

          if (isImagePart(c)) {
            return <ImageContent key={`image-${index}`} imagePart={c} />;
          }

          if (c.type === 'tool-call') {
            if (c.toolName === TOOL_NAMES.SEARCH_RESOURCE) {
              return (
                <AtomicSearchToolMessage key={c.toolCallId} toolCall={c} />
              );
            }

            if (c.toolName === TOOL_NAMES.GET_ATOMIC_RESOURCE) {
              return <AtomicFetchToolMessage key={c.toolCallId} toolCall={c} />;
            }

            if (c.toolName === TOOL_NAMES.EDIT_ATOMIC_RESOURCE) {
              return <AtomicEditToolMessage key={c.toolCallId} toolCall={c} />;
            }

            return (
              <ToolUseMessage key={c.toolCallId}>
                Using tool: <span>{c.toolName}</span>
              </ToolUseMessage>
            );
          }

          if (c.type === 'reasoning') {
            return (
              <ReasoningMessageWrapper key={c.text}>
                <span>Thinking...</span>
                <Markdown text={c.text} maxLength={Infinity} />
              </ReasoningMessageWrapper>
            );
          }
        })}
      </>
    );
  }

  return <span>Unknown message type</span>;
};

const RenderUserContent = ({ text }: { text: string }) => {
  const extractedText = text.match(/<context>([\s\S]*?)<\/context>/);

  if (extractedText) {
    return <Markdown text={text.replace(extractedText[0], '').trim()} />;
  }

  return <Markdown text={text} maxLength={Infinity} />;
};

const ImageContent = ({ imagePart }: { imagePart: ImagePart }) => {
  const imageSrc =
    typeof imagePart.image === 'string'
      ? imagePart.image
      : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; // Fallback 1x1 transparent image

  return (
    <MessageImageWrapper>
      <img src={imageSrc} alt='' />
    </MessageImageWrapper>
  );
};

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

const BasicMessage = ({ text }: { text: string }) => {
  return (
    <MessageWrapper>
      <Markdown text={text} maxLength={Infinity} />
    </MessageWrapper>
  );
};

interface ToolCallMessageProps {
  toolCall: ToolCallPart;
}

const AtomicSearchToolMessage = ({ toolCall }: ToolCallMessageProps) => {
  return (
    <ToolUseMessage key={toolCall.toolCallId}>
      <Row center gap='1ch'>
        <FaMagnifyingGlass />
        <div>
          Searching for{' '}
          <span>{(toolCall.args as { query: string }).query}</span>
        </div>
      </Row>
    </ToolUseMessage>
  );
};

const AtomicFetchToolMessage = ({ toolCall }: ToolCallMessageProps) => {
  const resources = useResources(
    (toolCall.args as { subjects: string[] }).subjects,
  );

  return (
    <>
      {Array.from(resources.values()).map(resource => (
        <ToolUseMessage key={toolCall.toolCallId}>
          <Row center gap='1ch'>
            Reading
            <span>
              {resource.title.slice(0, 20)}
              {resource.title.length > 20 ? '...' : ''}
            </span>
          </Row>
        </ToolUseMessage>
      ))}
    </>
  );
};

const AtomicEditToolMessage = ({ toolCall }: ToolCallMessageProps) => {
  const property = useResource(toolCall.args.property);
  const resource = useResource(toolCall.args.subject);

  return (
    <ToolUseMessage key={toolCall.toolCallId}>
      <Row center gap='0.7ch'>
        <FaPencil />
        Changing <ClippedTitle>{property.title}</ClippedTitle> on{' '}
        <ClippedTitle>{resource.title}</ClippedTitle>
      </Row>
    </ToolUseMessage>
  );
};

interface ToolResultMessageProps {
  toolResultPart: ToolResultPart;
}

const SearchResultMessage = ({ toolResultPart }: ToolResultMessageProps) => {
  const subjects = Object.keys(
    toolResultPart.result as Record<string, unknown>,
  );

  return (
    <div>
      <Details title='Search Results'>
        <ol>
          {subjects.map(resource => (
            <li key={resource}>
              <ResourceInline subject={resource} />
            </li>
          ))}
        </ol>
      </Details>
    </div>
  );
};

const MessageImageWrapper = styled.div`
  margin: ${p => p.theme.size(1)} 0;

  img {
    max-width: 100%;
    max-height: 300px;
    border-radius: ${p => p.theme.radius};
  }
`;

const MessageFileWrapper = styled.div`
  margin: ${p => p.theme.size(1)} 0;

  background-color: ${p => p.theme.colors.bg1};
  padding: ${p => p.theme.size(1)};
  border-radius: ${p => p.theme.radius};
`;

const ToolUseMessage = styled.div`
  background-color: ${p => p.theme.colors.mainSelectedBg};
  padding: ${p => p.theme.size(2)};
  border-radius: ${p => p.theme.radius};
  font-size: 0.7rem;
  width: fit-content;
  span {
    color: ${p => p.theme.colors.textLight};
  }
`;

const MessageWrapper = styled.div`
  border-radius: ${p => p.theme.radius};
  width: 90%;
  padding-block: ${p => p.theme.size()};
`;

const UserMessageWrapper = styled(MessageWrapper)`
  padding: ${p => p.theme.size()};
  background-color: ${p => p.theme.colors.bg};
  align-self: flex-end;
  box-shadow: ${p => p.theme.boxShadow};
`;

const ErrorMessageWrapper = styled(MessageWrapper)`
  padding: ${p => p.theme.size()};

  background-color: ${p => (p.theme.darkMode ? '#440e0e' : '#f8dbdb')};
`;

const ReasoningMessageWrapper = styled(MessageWrapper)`
  padding: ${p => p.theme.size()};
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
  max-height: 10rem;
  overflow-y: auto;
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

const StyledPre = styled.pre`
  background-color: ${p => p.theme.colors.bg};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
  overflow-x: auto;
  code {
    font-family: Monaco, monospace;
    font-size: 0.8em;
  }
`;

const ClippedTitle = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 20ch;
`;

const ContextItemRow = styled(Row)`
  margin-block-end: ${p => p.theme.size(2)};
`;
