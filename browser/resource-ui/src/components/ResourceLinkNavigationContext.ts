import { createContext } from 'react';

/** An overlay can dismiss itself after its resource link has opened. */
export const ResourceLinkNavigationContext = createContext<
  (() => void) | undefined
>(undefined);
