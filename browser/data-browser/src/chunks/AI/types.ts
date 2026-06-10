import type { UIMessage } from 'ai';
import { AIProvider } from '@components/AI/aiContstants';

export interface MCPServer {
  name: string;
  url: string;
  id: string;
  transport: 'http' | 'sse';
  headers?: Record<string, string>;
}

export interface AIAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  availableTools: string[];
  model?: AIModelIdentifier;
  canReadAtomicData: boolean;
  canWriteAtomicData: boolean;
  ragEnabled: boolean;
  skillsEnabled: boolean;
  temperature?: number;
  /** 0 disables auto-compact; otherwise compact when input tokens exceed this % of model context. */
  autoCompactThresholdPercent?: number;
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

export type AISkillMessageContext = {
  type: 'skill';
  id: string;
  name: string;
};

export type AIMessageContext =
  | AIAtomicResourceMessageContext
  | AIMCPResourceMessageContext
  | AISkillMessageContext;

export type MessageMetadata = {
  userContext?: AIMessageContext[];
  serverContext?: string;
  inputTokensUsed?: number;
  outputTokensUsed?: number;
  error?: string;
  isSummary?: boolean;
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

export function isSkillContext(
  context: AIMessageContext,
): context is AISkillMessageContext {
  return context.type === 'skill';
}

export type AIModelIdentifier = {
  id: string;
  provider: AIProvider;
};
