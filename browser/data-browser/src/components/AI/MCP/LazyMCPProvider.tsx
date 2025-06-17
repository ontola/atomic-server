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
