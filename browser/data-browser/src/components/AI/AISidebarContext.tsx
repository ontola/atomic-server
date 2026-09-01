import React, { useCallback, useContext, useState, createContext } from 'react';
import { randomUUID } from '@tomic/lib';

import type { AIMessageContext } from '../../chunks/AI/types';
import { useRightPanel } from '../RightPanel/RightPanelContext';

export const AISidebarContext = createContext<{
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  contextItems: AIMessageContext[];
  setContextItems: React.Dispatch<React.SetStateAction<AIMessageContext[]>>;
}>({
  isOpen: false,
  setIsOpen: () => {},
  contextItems: [],
  setContextItems: () => {},
});

export const useAISidebar = () => {
  return useContext(AISidebarContext);
};

/**
 * Open state lives in the shared RightPanelContext so the AI sidebar and the
 * Comments panel are mutually exclusive. This provider keeps the boolean
 * isOpen/setIsOpen API the AI components already use.
 */
export const AISidebarContextProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const { activePanel, setPanelOpen } = useRightPanel();
  const isOpen = activePanel === 'ai';

  const setIsOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    action => setPanelOpen('ai', action),
    [setPanelOpen],
  );

  const [contextItems, setContextItems] = useState<AIMessageContext[]>([]);

  return (
    <AISidebarContext.Provider
      value={{ isOpen, setIsOpen, contextItems, setContextItems }}
    >
      {children}
    </AISidebarContext.Provider>
  );
};

export function newContextItem<T extends AIMessageContext>(
  item: Omit<T, 'id'>,
): T {
  return {
    ...item,
    id: randomUUID() as string,
  } as T;
}
