import type { MCPServer } from './types';

export const defaultMCPServers: MCPServer[] = [
  {
    id: 'dev.atomicdata.mcp.exa',
    name: 'Web search',
    url: 'https://mcp.exa.ai/mcp',
    transport: 'http',
  },
];

export const getDefaultMCPServer = (serverId: string) =>
  defaultMCPServers.find(server => server.id === serverId);

const mergeDefaultMCPServerFields = (server: MCPServer): MCPServer => {
  const defaultServer = getDefaultMCPServer(server.id);

  if (!defaultServer) {
    return server;
  }

  return {
    ...server,
    name: defaultServer.name,
    url: defaultServer.url,
    transport: defaultServer.transport,
  };
};

export const mergeDefaultMCPServers = (servers: MCPServer[]): MCPServer[] => {
  const mergedServers = servers.map(mergeDefaultMCPServerFields);

  return [
    ...defaultMCPServers.map(
      defaultServer =>
        mergedServers.find(server => server.id === defaultServer.id) ??
        defaultServer,
    ),
    ...mergedServers.filter(server => !getDefaultMCPServer(server.id)),
  ];
};
