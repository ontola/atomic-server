import type { Resource } from '@tomic/react';

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
