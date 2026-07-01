import { useContext, useEffect } from 'react';
import { LazyAIChangesContext } from '@components/AI/AIChanges/LazyAIChangesProvider';
import { LazyMCPContext } from './LazyMCPProvider';

/** Loads MCP + AI review runtimes before rendering children. Not for the main bundle entry. */
export default function UsesMCPServers({ children }: React.PropsWithChildren) {
  const {
    load: loadMcp,
    isLoaded: mcpLoaded,
    isRuntimeReady: mcpReady,
  } = useContext(LazyMCPContext);
  const {
    load: loadAiChanges,
    isLoaded: aiLoaded,
    isRuntimeReady: aiReady,
  } = useContext(LazyAIChangesContext);

  useEffect(() => {
    if (!mcpLoaded) {
      loadMcp();
    }

    if (!aiLoaded) {
      loadAiChanges();
    }
  }, [mcpLoaded, loadMcp, aiLoaded, loadAiChanges]);

  return mcpLoaded && mcpReady && aiLoaded && aiReady ? children : null;
}
