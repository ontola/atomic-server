'use client';

import { StoreContext } from '@tomic/react';
import { CurrentSubjectProvider } from '@/app/context/CurrentSubjectProvider';
import { store } from '@/store';
import { initOntologies } from '@/ontologies';
import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getCurrentResource } from '@/atomic/getCurrentResource';

const ProviderWrapper = ({ children }: { children: React.ReactNode }) => {
  // Registers your ontologies with the store
  initOntologies();

  const pathname = usePathname();
  const [currentSubject, setCurrentSubject] = useState('');

  useEffect(() => {
    getCurrentResource(pathname).then(resource => {
      setCurrentSubject(resource?.subject ?? '');
    });
  }, [pathname]);

  return (
    <StoreContext.Provider value={store}>
      <CurrentSubjectProvider currentSubject={currentSubject}>
        {children}
      </CurrentSubjectProvider>
    </StoreContext.Provider>
  );
};

export default ProviderWrapper;
