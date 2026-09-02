import { createContext, lazy, Suspense, useCallback, useState } from 'react';
import {
  defaultMcpServersValue,
  McpServersContext,
  type McpServersContextType,
} from './McpServersContext';

const McpServersRuntime = lazy(() =>
  import('./McpServersRuntime').then(m => ({ default: m.McpServersRuntime })),
);

interface LazyMCPContextType {
  load: () => void;
  isLoaded: boolean;
  isRuntimeReady: boolean;
}

export const LazyMCPContext = createContext<LazyMCPContextType>({
  load: () => {},
  isLoaded: false,
  isRuntimeReady: false,
});

/** Lazy-loads MCP after `load()`; keeps a stable provider boundary so the app tree does not remount. */
export const LazyMCPProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isRuntimeReady, setIsRuntimeReady] = useState(false);
  const [mcpValue, setMcpValue] = useState<McpServersContextType>(
    defaultMcpServersValue,
  );

  const load = useCallback(() => {
    setIsLoaded(true);
  }, []);

  const onRuntimeReady = useCallback(() => {
    setIsRuntimeReady(true);
  }, []);

  return (
    <LazyMCPContext.Provider value={{ load, isLoaded, isRuntimeReady }}>
      <McpServersContext.Provider value={mcpValue}>
        {children}
        {isLoaded && (
          <Suspense fallback={null}>
            <McpServersRuntime
              setValue={setMcpValue}
              onRuntimeReady={onRuntimeReady}
            />
          </Suspense>
        )}
      </McpServersContext.Provider>
    </LazyMCPContext.Provider>
  );
};
