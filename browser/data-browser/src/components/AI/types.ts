import type { CoreMessage, CoreUserMessage } from 'ai';

export interface MCPServer {
  name: string;
  url: string;
  id: string;
}

export interface AIAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  availableTools: string[];
  model: string;
  canReadAtomicData: boolean;
  canWriteAtomicData: boolean;
}

export enum AIState {
  Generating,
  UsingTool,
  Stopped,
  SelectingAgent,
}

export type AIResourceMessageContext = {
  type: 'resource';
  id: string;
  subject: string;
};

export type AIMessageContext = AIResourceMessageContext;

export type AIChatErrorMessage = {
  role: 'error';
  content: string;
};

export type MessageWithContext = {
  role: 'annotated-message';
  message: CoreMessage;
  context: AIMessageContext[];
};

export type AIChatDisplayMessage =
  | CoreMessage
  | AIChatErrorMessage
  | MessageWithContext;

export function isAIErrorMessage(
  message: AIChatDisplayMessage,
): message is AIChatErrorMessage {
  return message.role === 'error';
}

export function isUserMessage(
  message: CoreMessage,
): message is CoreUserMessage {
  return message.role === 'user';
}

export function isMessageWithContext(
  message: AIChatDisplayMessage,
): message is MessageWithContext {
  return message.role === 'annotated-message';
}
