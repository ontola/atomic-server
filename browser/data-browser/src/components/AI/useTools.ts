import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { useEffect, useState } from 'react';
import { useSettings } from '../../helpers/AppSettings';
import type { AIAgent, MCPServer } from './types';
import {
  experimental_createMCPClient as createMCPClient,
  type ToolSet,
} from 'ai';

// The mcp ts library does not export a type for this so we have to infer it.
export type MCPTool = Awaited<
  ReturnType<(typeof Client)['prototype']['listTools']>
>['tools'][number];

export type MCPToolCallResult = {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError: boolean;
};

export function useTools() {
  const { mcpServers } = useSettings();
  const [toolSets, setToolSets] = useState<Record<string, ToolSet>>({});

  useEffect(() => {
    (async () => {
      // Create a client for each MCP server.
      const connectedClients = (
        await Promise.allSettled(
          mcpServers.map(async server => {
            const client = await createMCPClient({
              transport: {
                type: 'sse',
                url: server.url,
              },
            });

            return {
              id: server.id,
              client,
            };
          }),
        )
      )
        .filter(p => p.status === 'fulfilled')
        .map(p => p.value);

      // Get the tools for each client.
      const toolList = await Promise.all(
        connectedClients.map(async c => {
          const tools = await c.client.tools({
            schemas: 'automatic',
          });

          return {
            id: c.id,
            tools,
          };
        }),
      );

      const _tools = toolList.reduce(
        (acc, t) => ({
          ...acc,
          [t.id]: t.tools,
        }),
        {} as Record<string, ToolSet>,
      );

      console.log(_tools);
      setToolSets(_tools);
    })();
  }, [mcpServers]);

  const getToolsForAgent = (agent: AIAgent) => {
    console.log('toolSets', toolSets);
    console.log('agent', agent);
    const agentTools = agent.availableTools.reduce(
      (acc, id) => ({
        ...acc,
        ...(toolSets[id] || {}),
      }),
      {},
    );

    console.log('picked agentTools', agentTools);

    return agentTools;
  };

  return getToolsForAgent;
}
