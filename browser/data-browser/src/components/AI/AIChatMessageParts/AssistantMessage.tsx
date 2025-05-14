import React from 'react';
import { TOOL_NAMES } from '../useAtomicTools';
import {
  AtomicEditToolMessage,
  AtomicFetchToolMessage,
  AtomicSearchToolMessage,
  BasicMessage,
  ImageContent,
  isImagePart,
  ReasoningMessage,
} from './index';
import type { CoreAssistantMessage, ToolCallPart } from 'ai';
import styled from 'styled-components';

interface AssistantMessageProps {
  message: CoreAssistantMessage;
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  message,
}) => {
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
          switch (c.toolName) {
            case TOOL_NAMES.SEARCH_RESOURCE:
              return (
                <AtomicSearchToolMessage key={c.toolCallId} toolCall={c} />
              );
            case TOOL_NAMES.GET_ATOMIC_RESOURCE:
              return <AtomicFetchToolMessage key={c.toolCallId} toolCall={c} />;
            case TOOL_NAMES.EDIT_ATOMIC_RESOURCE:
              return <AtomicEditToolMessage key={c.toolCallId} toolCall={c} />;
            case TOOL_NAMES.CREATE_RESOURCE:
              return (
                <BasicCustomToolUseMessage key={c.toolCallId} toolCall={c}>
                  Creating Resource
                </BasicCustomToolUseMessage>
              );
            default:
              return (
                <ToolUseMessage key={c.toolCallId}>
                  Using tool: <span>{c.toolName}</span>
                </ToolUseMessage>
              );
          }
        }

        if (c.type === 'reasoning') {
          return <ReasoningMessage key={c.text} text={c.text} />;
        }

        return null;
      })}
    </>
  );
};

interface ToolCallMessageProps {
  toolCall: ToolCallPart;
}

const BasicCustomToolUseMessage = ({
  toolCall,
  children,
}: React.PropsWithChildren<ToolCallMessageProps>) => {
  return (
    <ToolUseMessage key={toolCall.toolCallId}>
      <span>{children}</span>
    </ToolUseMessage>
  );
};

const ToolUseMessage = styled.div`
  background-color: var(--mainSelectedBg);
  padding: 0.5em;
  border-radius: var(--radius);
  font-size: 0.7rem;
  width: fit-content;
  color: var(--textLight);
`;
