'use client';

import { StoreContext } from '@tomic/react';
import { CurrentSubjectProvider } from '@/app/context/CurrentSubjectContext';
import { store } from '@/store';
import { initOntologies } from '@/ontologies';
import React from 'react';

const ProviderWrapper = ({ children }: { children: React.ReactNode }) => {
  initOntologies();

  return (
    <StoreContext.Provider value={store}>
      <CurrentSubjectProvider>{children}</CurrentSubjectProvider>
    </StoreContext.Provider>
  );
};

export default ProviderWrapper;
