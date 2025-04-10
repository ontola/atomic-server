import { ChatLoadingIndicator } from '@components/AI/ChatLoadingIndicator';
import type { Ai } from '@tomic/react';
import type { ResourcePageProps } from '@views/ResourcePage';
import React, { Suspense } from 'react';

const AIChatPageAsync = React.lazy(() => import('@chunks/AI/AIChatPage'));

export const AIChatPage: React.FC<ResourcePageProps<Ai.AiChat>> = props => {
  return (
    <Suspense fallback={<ChatLoadingIndicator />}>
      <AIChatPageAsync {...props} />
    </Suspense>
  );
};
