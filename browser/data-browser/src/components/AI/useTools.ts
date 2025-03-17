import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { useEffect, useState } from 'react';
import { useSettings } from '../../helpers/AppSettings';
import type { AIAgent, MCPServer } from './types';
import {
  jsonSchema,
  tool,
  type Tool,
  type ToolCallPart,
  experimental_createMCPClient as createMCPClient,
  type ToolSet,
} from 'ai';
import toast from 'react-hot-toast';

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

export function useToolsOLD(
  removeEnumParams = false,
): [
  tools: Record<string, Tool>,
  callTool: (tool: ToolCallPart) => Promise<MCPToolCallResult>,
] {
  const { mcpServers } = useSettings();
  const [clients, setClients] = useState<Client[]>([]);
  const [tools, setTools] = useState<Record<string, Tool>>({});
  const [toolToClientMap, setToolToClientMap] = useState<
    Record<string, Client>
  >({});

  const callTool = async (toolCall: ToolCallPart) => {
    console.log(
      'calling tool: ',
      toolCall.toolName,
      'with args: ',
      toolCall.args,
    );
    const client = toolToClientMap[toolCall.toolName];

    if (!client) {
      throw new Error(`Client for tool ${toolCall.toolName} not found`);
    }

    try {
      const result = await client.callTool({
        name: toolCall.toolName,
        arguments: toolCall.args as Record<string, unknown>,
      });

      console.log('tool call result', result);

      return result;
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: err.message,
          },
        ],
        isError: true,
      };
    }
  };

  useEffect(() => {
    let _clients: Client[] = [];

    Promise.allSettled(mcpServers.map(server => createClient(server)))
      .then(res => {
        _clients = res.filter(c => c.status === 'fulfilled').map(c => c.value);
        setClients(_clients);

        for (const c of _clients) {
          c.listResources().then(console.log);
        }
      })
      .catch(err => {
        console.error(err);
        toast.error('Failed to load MCP servers');
      });

    return () => {
      _clients?.forEach(client => client.close());
    };
  }, [mcpServers]);

  useEffect(() => {
    Promise.all(clients.map(client => client.listTools())).then(toolResults => {
      const foundTools: Record<string, Tool> = {};
      const _toolToClientMap: Record<string, Client> = {};

      toolResults.forEach((toolResult, clientIndex) => {
        for (const t of toolResult.tools) {
          if (removeEnumParams && hasEnumParam(t)) {
            console.log('Removed tool with enum param', t.name, t);
            continue;
          }

          console.log(t);
          foundTools[t.name] = tool({
            description: t.description,
            //@ts-expect-error
            parameters: jsonSchema(t.inputSchema),
          });

          _toolToClientMap[t.name] = clients[clientIndex];
        }
      });

      setTools(foundTools);
      setToolToClientMap(_toolToClientMap);
    });
  }, [clients, removeEnumParams]);

  return [tools, callTool];
}

async function createClient(server: MCPServer) {
  const transport = new SSEClientTransport(new URL(server.url), {});

  const client = new Client({
    name: 'Atomic Data Browser',
    version: '1.0.0',
  });

  try {
    await client.connect(transport);
  } catch (err) {
    console.error(err);
    // If the client could not connect, close it so it doesn't continue to try to reconnect.
    client.close();
    throw err;
  }

  return client;
}

function hasEnumParam(mcpTool: MCPTool) {
  if (!mcpTool.inputSchema.properties) {
    return false;
  }

  return Object.values(mcpTool.inputSchema.properties).some(
    v => 'enum' in (v as Record<string, unknown>),
  );
  6;
}
