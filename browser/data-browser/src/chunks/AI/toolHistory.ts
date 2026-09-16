// @wc-ignore-file
import {
  convertToModelMessages,
  getToolName,
  isToolUIPart,
  type ToolUIPart,
  type DynamicToolUIPart,
} from 'ai';
import { ai, type JSONValue } from '@tomic/react';
import type { AtomicUIMessage } from './types';

/** Only repairs the outgoing model history; never replays tools or rewrites saved history. */
export function modelMessagesWithToolRecovery(messages: AtomicUIMessage[]) {
  const annotated = messages.map(message => ({
    ...message,
    parts: message.parts.map(part => {
      if (
        isToolUIPart(part) &&
        (part.state === 'input-streaming' || part.state === 'input-available')
      ) {
        return {
          type: 'text' as const,
          text: `Previous tool call ${part.toolCallId} (${getToolName(part)}) has no recorded result. Its outcome is unknown. Check current state before retrying any operation that could already have taken effect.`,
        };
      }
      return part;
    }),
  }));
  return convertToModelMessages(annotated);
}

export function toolPartValues(part: ToolUIPart | DynamicToolUIPart): {
  [ai.properties.toolName]: string;
  [ai.properties.toolId]: string;
  [ai.properties.toolInput]?: JSONValue;
  [ai.properties.toolOutput]?: JSONValue;
  [ai.properties.toolResultIsError]?: boolean;
} {
  return {
    [ai.properties.toolName]: getToolName(part),
    [ai.properties.toolId]: part.toolCallId,
    ...(part.input !== undefined
      ? { [ai.properties.toolInput]: part.input as JSONValue }
      : {}),
    ...(part.state === 'output-error'
      ? {
          [ai.properties.toolResultIsError]: true,
          [ai.properties.toolOutput]: part.errorText,
        }
      : part.output !== undefined
        ? { [ai.properties.toolOutput]: part.output as JSONValue }
        : {}),
  };
}

export function restoreToolPart(props: {
  toolName: string;
  toolId: string;
  toolInput?: JSONValue;
  toolOutput?: JSONValue;
  toolResultIsError?: boolean;
}): ToolUIPart {
  const base = {
    type: `tool-${props.toolName}` as const,
    toolCallId: props.toolId,
    input: props.toolInput,
  };
  if (props.toolResultIsError) {
    return {
      ...base,
      state: 'output-error',
      errorText:
        typeof props.toolOutput === 'string'
          ? props.toolOutput
          : 'Tool failed; no error details were recorded.',
    };
  }
  if (props.toolOutput !== undefined) {
    return { ...base, state: 'output-available', output: props.toolOutput };
  }
  return {
    ...base,
    state:
      props.toolInput === undefined ? 'input-streaming' : 'input-available',
  };
}
