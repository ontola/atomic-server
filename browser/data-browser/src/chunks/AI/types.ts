import type { UIMessage } from 'ai';
import { AIProvider } from '@components/AI/aiContstants';

export interface MCPServer {
  name: string;
  url: string;
  id: string;
  transport: 'http' | 'sse';
}

export interface AIAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  availableTools: string[];
  model: AIModelIdentifier;
  canReadAtomicData: boolean;
  canWriteAtomicData: boolean;
  temperature?: number;
}

export enum AIState {
  Generating,
  UsingTool,
  Stopped,
  SelectingAgent,
}

export type AIAtomicResourceMessageContext = {
  type: 'atomic-resource';
  id: string;
  subject: string;
};

export type AIMCPResourceMessageContext = {
  type: 'mcp-resource';
  id: string;
  uri: string;
  name: string;
  mimetype?: string;
  serverId: string;
};

export type AIMessageContext =
  | AIAtomicResourceMessageContext
  | AIMCPResourceMessageContext;

export type MessageMetadata = {
  context?: AIMessageContext[];
  inputTokensUsed?: number;
  outputTokensUsed?: number;
  error?: string;
};

export type AtomicUIMessage = UIMessage<MessageMetadata>;

export function isMCPResource(
  context: AIMessageContext,
): context is AIMCPResourceMessageContext {
  return context.type === 'mcp-resource';
}

export function isAtomicResourceContext(
  context: AIMessageContext,
): context is AIAtomicResourceMessageContext {
  return context.type === 'atomic-resource';
}

export type AIModelIdentifier = {
  id: string;
  provider: AIProvider;
};
