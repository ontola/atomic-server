import React from 'react';
import { isToolUIPart } from 'ai';
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

        if (isToolUIPart(part)) {
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
