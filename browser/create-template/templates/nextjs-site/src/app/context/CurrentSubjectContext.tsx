'use client';

import { env } from '@/env';
import { createContext, useContext, useState } from 'react';

interface CurrentSubjectContextType {
  currentSubject: string;
  setCurrentSubject: (newSubject: string) => void;
}

const CurrentSubjectContext = createContext<
  CurrentSubjectContextType | undefined
>(undefined);

export const CurrentSubjectProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [currentSubject, setCurrentSubject] = useState<string>(
    env.NEXT_PUBLIC_WEBSITE_RESOURCE,
  );
  return (
    <CurrentSubjectContext.Provider
      value={{
        currentSubject,
        setCurrentSubject,
      }}
    >
      {children}
    </CurrentSubjectContext.Provider>
  );
};

export const useCurrentSubject = () => {
  const context = useContext(CurrentSubjectContext);
  if (!context) {
    throw new Error(
      'useCurrentSubject must be used within a CurrentSubjectProvider',
    );
  }
  return context;
};
