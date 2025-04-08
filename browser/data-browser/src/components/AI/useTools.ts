import { useEffect, useState } from 'react';
import type { AIAgent } from './types';
import { jsonSchema, tool, type Tool, type ToolSet } from 'ai';
import { useMcpServers } from './MCP/useMcpServers';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export type MCPToolCallResult = {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError: boolean;
};

// Thanks to the heavy use of zod the mcp sdk doesn't have an actual type for tools so we have to infer it from the return type of listTools.
type MCPTool = Awaited<
  ReturnType<(typeof Client)['prototype']['listTools']>
>['tools'][number];

const convertTool = (t: MCPTool, client: Client): Tool => {
  return tool({
    description: t.description,
    inputSchema: jsonSchema({
      ...t.inputSchema,
      properties:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (t.inputSchema.properties as Record<string, any>) ?? {},
      additionalProperties: false,
    }),
    execute: async (args: Record<string, unknown>) => {
      const result = await client.callTool({
        name: t.name,
        arguments: args,
      });

      if (result.isError) {
        return result.content;
      }

      return result.content;
    },
  });
};

export function useTools() {
  const { clients } = useMcpServers();
  const [toolSets, setToolSets] = useState<Record<string, ToolSet>>({});

  const getToolsForAgent = (agent: AIAgent): ToolSet => {
    const agentTools = agent.availableTools.reduce(
      (acc, id) => ({
        ...acc,
        ...(toolSets[id] || {}),
      }),
      {},
    );

    return agentTools;
  };

  useEffect(() => {
    for (const [name, client] of Object.entries(clients)) {
      client.listTools().then(tools => {
        const convertedTools: Record<string, Tool> = {};

        for (const t of tools.tools) {
          const convertedTool = convertTool(t, client);
          convertedTools[t.name] = convertedTool;
        }

        setToolSets(prev => ({ ...prev, [name]: convertedTools }));
      });
    }
  }, [clients]);

  return getToolsForAgent;
}
