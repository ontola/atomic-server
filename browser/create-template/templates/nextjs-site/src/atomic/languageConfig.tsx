'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { LanguageConfig } from './i18n';

const LanguageConfigContext = createContext<LanguageConfig>({
  defaultLanguage: 'en',
  languages: ['en'],
});

export function LanguageConfigProvider({
  value,
  children,
}: {
  value: LanguageConfig;
  children: ReactNode;
}) {
  return (
    <LanguageConfigContext.Provider value={value}>
      {children}
    </LanguageConfigContext.Provider>
  );
}

export function useLanguageConfig(): LanguageConfig {
  return useContext(LanguageConfigContext);
}
