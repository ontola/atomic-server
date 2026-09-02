import React, { Suspense } from 'react';
import { useAISidebar } from './AISidebarContext';
import { ChatLoadingIndicator } from './ChatLoadingIndicator';
import { RightPanel } from '../RightPanel/RightPanel';

const AISidebar = React.lazy(() => import('@chunks/AI/AISidebar'));

export const AISidebarContainer: React.FC = () => {
  const { isOpen } = useAISidebar();

  return (
    <RightPanel isOpen={isOpen} testId='ai-sidebar'>
      <Suspense fallback={<ChatLoadingIndicator />}>
        {isOpen && <AISidebar />}
      </Suspense>
    </RightPanel>
  );
};
