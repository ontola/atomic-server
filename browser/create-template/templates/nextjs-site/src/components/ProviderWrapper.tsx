'use client';

import { StoreContext } from '@tomic/react';
import { CurrentSubjectProvider } from '@/app/context/CurrentSubjectContext';
import { store } from '@/app/store';
import { initOntologies } from '@/ontologies';

const ProviderWrapper = ({
  children,
}: {
  children: Readonly<React.ReactNode>;
}) => {
  initOntologies();

  return (
    <StoreContext.Provider value={store}>
      <CurrentSubjectProvider>{children}</CurrentSubjectProvider>
    </StoreContext.Provider>
  );
};

export default ProviderWrapper;
