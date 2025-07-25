import React, { useContext, useState, createContext } from 'react';

import type { AIMessageContext } from './types';
import { useLocalStorage } from '../../hooks/useLocalStorage';

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
export const AISidebarContextProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const [isOpen, setIsOpen] = useLocalStorage('atomic.aiSidebar.open', false);
  const [contextItems, setContextItems] = useState<AIMessageContext[]>([]);

  return (
    <AISidebarContext.Provider
      value={{ isOpen, setIsOpen, contextItems, setContextItems }}
    >
      {children}
    </AISidebarContext.Provider>
  );
};

export const newContextItem = <T extends AIMessageContext>(
  item: Omit<T, 'id'>,
): T => {
  return {
    ...item,
    id: crypto.randomUUID() as string,
  } as T;
};
