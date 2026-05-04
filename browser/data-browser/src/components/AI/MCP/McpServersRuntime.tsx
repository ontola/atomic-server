import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { QuickScore } from 'quick-score';
import type { MCPServer } from '../../../chunks/AI/types';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { useAISettings } from '../AISettingsContext';
import type {
  McpServersContextType,
  ReadMCPResource,
  SearchResourcesOfServer,
} from './McpServersContext';

const createTransport = (server: MCPServer) => {
  const options = server.headers
    ? {
        requestInit: {
          headers: server.headers,
        },
      }
    : undefined;

  if (server.transport === 'sse') {
    return new SSEClientTransport(new URL(server.url), options);
  }

  if (server.transport === 'http') {
    return new StreamableHTTPClientTransport(new URL(server.url), options);
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

export const McpServersRuntime: React.FC<{
  setValue: React.Dispatch<React.SetStateAction<McpServersContextType>>;
  onRuntimeReady: () => void;
}> = ({ setValue, onRuntimeReady }) => {
  const { mcpServers } = useAISettings();
  const [clients, setClients] = useState<Record<string, Client>>({});
  const [serversWithResources, setServersWithResources] = useState<string[]>(
    [],
  );
  const clientsRef = useRef(clients);
  clientsRef.current = clients;

  const hasReportedReadyRef = useRef(false);

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
      Object.values(clientsRef.current).forEach(client => client.close());
    };
  }, [mcpServers]);

  const searchResourcesOfServer: SearchResourcesOfServer = useCallback(
    async (serverId, query, limit) => {
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
    },
    [clients, serversWithResources],
  );

  const readMCPResource: ReadMCPResource = useCallback(
    async (serverId, uri) => {
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
    },
    [clients],
  );

  useEffect(() => {
    setValue({
      clients,
      serversWithResources,
      searchResourcesOfServer,
      readMCPResource,
    });

    if (!hasReportedReadyRef.current) {
      hasReportedReadyRef.current = true;
      onRuntimeReady();
    }
  }, [
    clients,
    serversWithResources,
    searchResourcesOfServer,
    readMCPResource,
    setValue,
    onRuntimeReady,
  ]);

  return null;
};
