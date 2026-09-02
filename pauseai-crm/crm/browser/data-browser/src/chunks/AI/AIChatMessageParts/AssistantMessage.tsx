import React from 'react';
import { styled } from 'styled-components';
import { isStaticToolUIPart } from 'ai';
import type { AtomicUIMessage } from '../types';
import { FileContent } from './FileContent';
import { MessageToolPart } from './MessageToolPart';
import { SourceUrlPart } from './SourceUrlPart';
import { BasicMessage } from './BasicMessage';
import { ReasoningMessage } from './ReasoningMessage';

interface AssistantMessageProps {
  message: AtomicUIMessage;
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  message,
}) => {
  return (
    <>
      {/* A turn that failed mid-flight. The metadata was already being written
          on error, but nothing rendered it, so a half-finished answer looked
          like a complete one. */}
      {message.metadata?.error && (
        <ErrorNotice role='alert'>{message.metadata.error}</ErrorNotice>
      )}
      {message.parts.map((part, index) => {
        if (part.type === 'text') {
          if (part.text.length === 0) {
            return null;
          }

          return <BasicMessage key={index} text={part.text} />;
        }

        if (part.type === 'file') {
          return <FileContent key={index} part={part} />;
        }

        if (isStaticToolUIPart(part)) {
          return <MessageToolPart key={index} part={part} />;
        }

        if (part.type === 'reasoning') {
          return (
            <ReasoningMessage key={index} text={part.text} state={part.state} />
          );
        }

        if (part.type === 'source-url') {
          return <SourceUrlPart key={index} part={part} />;
        }

        return null;
      })}
    </>
  );
};

const ErrorNotice = styled.div`
  padding: ${p => p.theme.size(2)} ${p => p.theme.size(3)};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.alert}1a;
  border: 1px solid ${p => p.theme.colors.alert}55;
  color: ${p => p.theme.colors.text};
  font-size: 0.85rem;
`;
