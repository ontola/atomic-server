import { useContext, useEffect } from 'react';
import { LazyMCPContext } from './LazyMCPProvider';

/** Loads the lazy MCP runtime before rendering children. Not for use in the main bundle entry. */
export default function UsesMCPServers({ children }: React.PropsWithChildren) {
  const { load, isLoaded, isRuntimeReady } = useContext(LazyMCPContext);

  useEffect(() => {
    if (!isLoaded) {
      load();
    }
  }, [isLoaded, load]);

  return isLoaded && isRuntimeReady ? children : null;
}
