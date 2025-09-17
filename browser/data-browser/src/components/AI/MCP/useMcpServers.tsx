import React, { createContext, useContext, useEffect, useState } from 'react';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { QuickScore } from 'quick-score';
import type { MCPServer } from '../../../chunks/AI/types';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { useAISettings } from '../AISettingsContext';

export type MCPResourceMeta = {
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
};

export type SearchResourcesOfServer = (
  serverId: string,
  query: string,
  limit?: number,
) => Promise<MCPResourceMeta[]>;

export type ReadMCPResource = (
  serverId: string,
  uri: string,
) => Promise<{ contents: unknown; mimeType?: string }>;

type McpServersContextType = {
  clients: Record<string, Client>;
  serversWithResources: string[];
  searchResourcesOfServer: SearchResourcesOfServer;
  readMCPResource: ReadMCPResource;
};

const McpServersContext = createContext<McpServersContextType | undefined>(
  undefined,
);

const createTransport = (server: MCPServer) => {
  if (server.transport === 'sse') {
    return new SSEClientTransport(new URL(server.url), {});
  }

  if (server.transport === 'http') {
    return new StreamableHTTPClientTransport(new URL(server.url));
  }

  throw new Error(`Unknown transport: ${server.transport}`);
};

const connectToServer = async (server: MCPServer) => {
  const transport = createTransport(server);
  const client = new Client({
    name: server.name,
    version: '1.0.0',
  });

  try {
    await client.connect(transport);
  } catch (error) {
    client.close();
    throw error;
  }

  return { client, id: server.id };
};

export const McpServersProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const { mcpServers } = useAISettings();
  const [clients, setClients] = useState<Record<string, Client>>({});
  const [serversWithResources, setServersWithResources] = useState<string[]>(
    [],
  );

  useEffect(() => {
    for (const server of mcpServers) {
      connectToServer(server)
        .then(({ id, client }) => {
          setClients(prev => ({ ...prev, [id]: client }));

          if (client.getServerCapabilities()?.resources) {
            setServersWithResources(prev => Array.from(new Set([...prev, id])));
          }
        })
        .catch(error => {
          console.error(error);
        });
    }

    return () => {
      Object.values(clients).forEach(client => client.close());
    };
  }, [mcpServers]);

  const searchResourcesOfServer: SearchResourcesOfServer = async (
    serverId,
    query,
    limit,
  ) => {
    if (!serversWithResources.includes(serverId)) {
      throw new Error(`Server ${serverId} does not support resources`);
    }

    const client = clients[serverId];

    if (!client) {
      throw new Error(`Client for ${serverId} not found`);
    }

    const { resources } = await client.listResources();
    const quickscore = new QuickScore(resources, {
      keys: ['name'],
      minimumScore: 0.8,
    });
    const results = quickscore.search(query);

    return results
      .map(r => ({
        name: r.item.name,
        uri: r.item.uri,
        description: r.item.description,
      }))
      .slice(0, limit ?? results.length);
  };

  const readMCPResource: ReadMCPResource = async (serverId, uri) => {
    const client = clients[serverId];

    if (!client) {
      throw new Error(`Client for ${serverId} not found`);
    }

    const result = await client.readResource({ uri });

    return {
      contents: result.contents,
      mimeType:
        typeof result.mimeType === 'string' ? result.mimeType : undefined,
    };
  };

  return (
    <McpServersContext.Provider
      value={{
        serversWithResources,
        searchResourcesOfServer,
        clients,
        readMCPResource,
      }}
    >
      {children}
    </McpServersContext.Provider>
  );
};

export const useMcpServers = () => {
  const ctx = useContext(McpServersContext);
  if (!ctx)
    throw new Error('useMcpServers must be used within a McpServersProvider');

  return ctx;
};
