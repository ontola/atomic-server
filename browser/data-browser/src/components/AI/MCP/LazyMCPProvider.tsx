import { createContext, lazy, Suspense, useState } from 'react';

const MCPServersProvider = lazy(() =>
  import('./useMcpServers').then(m => ({ default: m.McpServersProvider })),
);

interface LazyMCPContextType {
  load: () => void;
  isLoaded: boolean;
}

export const LazyMCPContext = createContext<LazyMCPContextType>({
  load: () => {},
  isLoaded: false,
});

/**
 * Provider wrapper for the MCPServersProvider.
 * Because MCP logic uses severel larger libraries we want to defer loading the provider until it is needed by an AI chat.
 * Therefore any AI entrypoint component should call the load function to start loading the provider.
 */
export const LazyMCPProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const [isLoaded, setIsLoaded] = useState(false);

  const load = () => {
    setIsLoaded(true);
  };

  return (
    <Suspense>
      <LazyMCPContext.Provider value={{ load, isLoaded }}>
        {isLoaded ? (
          <MCPServersProvider>{children}</MCPServersProvider>
        ) : (
          children
        )}
      </LazyMCPContext.Provider>
    </Suspense>
  );
};
