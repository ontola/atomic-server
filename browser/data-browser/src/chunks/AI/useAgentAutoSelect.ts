import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { useAIAgentConfig } from './AgentConfig';
import type { AIAgent, MCPServer } from './types';
import { useSettings } from '@helpers/AppSettings';
import { generateObject } from 'ai';
import { z } from 'zod';

function agentToText(agent: AIAgent, mcpServers: MCPServer[]) {
  return `ID: ${agent.id} Name: ${agent.name} Description: ${agent.description} Tools: ${agent.availableTools.map(t => mcpServers.find(s => s.id === t)?.name).join(', ')}`;
}

export const useAutoAgentSelect = () => {
  const { mcpServers, openRouterApiKey } = useSettings();
  const { agents } = useAIAgentConfig();

  const openrouter = createOpenRouter({
    apiKey: openRouterApiKey,
    compatibility: 'strict',
  });

  const basePrompt = `You are part of an AI Chat application. It is your job to determine what agent to use to answer the users question.
These are the agents you can choose from:

${agents.map(agent => agentToText(agent, mcpServers)).join('\n')}

Answer with only the ID of the agent you pick.

User question: `;

  const pickAgent = async (question: string): Promise<AIAgent> => {
    if (!openRouterApiKey) {
      throw new Error(
        'Automatic agent selection requires an OpenRouter API key.',
      );
    }

    const prompt = basePrompt + question.trim();

    const { object } = await generateObject({
      model: openrouter('google/gemma-3-4b-it:free'),
      schemaName: 'Agent',
      schemaDescription: 'The agent to use for the question.',
      schema: z.object({
        agentId: z.string(),
      }),
      prompt,
    });

    const agent = agents.find(a => a.id === object.agentId);

    if (!agent) {
      throw new Error('Agent not found');
    }

    return agent;
  };

  return pickAgent;
};
