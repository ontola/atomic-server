import { createLazyRoute } from '@tanstack/react-router';
import { ContainerFull, ContainerNarrow } from '../components/Containers';

import type { JSX } from 'react';
import { SimpleAIChat } from '../components/AI/SimpleAIChat';
import { core, useResource, useStore } from '@tomic/react';

function Sandbox(): JSX.Element {
  // const store = useStore();

  const name = useResource(core.properties.name);

  return (
    <main>
      {/* <SimpleAIChat />  */}
      {name.title}
    </main>
  );
}

export const sandboxRouteLazy = createLazyRoute('/$')({
  component: Sandbox,
});
