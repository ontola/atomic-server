import { createLazyRoute } from '@tanstack/react-router';
import { ContainerFull } from '../components/Containers';

import type { JSX } from 'react';

function Sandbox(): JSX.Element {
  return (
    <main>
      <ContainerFull>
        <h1>Sandbox</h1>
        <p>
          Welcome to the sandbox. This is a place to test components in
          isolation.
        </p>
      </ContainerFull>
    </main>
  );
}

export const sandboxRouteLazy = createLazyRoute('/$')({
  component: Sandbox,
});
