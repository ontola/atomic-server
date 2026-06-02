import { createContext, useContext } from 'react';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

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

export type McpServersContextType = {
  clients: Record<string, Client>;
  serversWithResources: string[];
  searchResourcesOfServer: SearchResourcesOfServer;
  readMCPResource: ReadMCPResource;
};

const notReadySearch: SearchResourcesOfServer = async () => {
  throw new Error('MCP servers are not loaded yet');
};

const notReadyRead: ReadMCPResource = async () => {
  throw new Error('MCP servers are not loaded yet');
};

export const defaultMcpServersValue: McpServersContextType = {
  clients: {},
  serversWithResources: [],
  searchResourcesOfServer: notReadySearch,
  readMCPResource: notReadyRead,
};

export const McpServersContext = createContext<McpServersContextType>(
  defaultMcpServersValue,
);

export const useMcpServers = () => useContext(McpServersContext);
