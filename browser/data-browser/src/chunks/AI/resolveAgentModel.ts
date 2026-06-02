import type { AIAgent, AIModelIdentifier } from './types';

export const BUILTIN_AGENT_IDS = [
  'dev.atomicdata.atomic-agent',
  'dev.atomicdata.general-agent',
] as const;

export type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];

export const isBuiltinAgent = (agent: AIAgent | string): boolean => {
  const id = typeof agent === 'string' ? agent : agent.id;

  return (BUILTIN_AGENT_IDS as readonly string[]).includes(id);
};

/** Apply a default model preset to built-in agents (e.g. during initial setup). */
export const applyDefaultModelToBuiltinAgents = (
  agents: AIAgent[],
  model: AIModelIdentifier,
): AIAgent[] =>
  agents.map(agent =>
    isBuiltinAgent(agent) ? { ...agent, model: { ...model } } : agent,
  );
