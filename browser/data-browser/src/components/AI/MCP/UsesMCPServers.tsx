import { useContext, useEffect } from 'react';
import { LazyMCPContext } from './LazyMCPProvider';

/**
 * A component that makes sure the MCPServersProvider is loaded before rendering the children.
 * Do not use this component in any main bundle component.
 */
export default function UsesMCPServers({ children }: React.PropsWithChildren) {
  const { load, isLoaded } = useContext(LazyMCPContext);

  useEffect(() => {
    if (!isLoaded) {
      load();
    }
  }, [isLoaded, load]);

  return isLoaded ? children : null;
}
