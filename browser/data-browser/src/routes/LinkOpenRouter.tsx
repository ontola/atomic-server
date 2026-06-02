import { createRoute } from '@tanstack/react-router';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import { useEffect, useEffectEvent, useState } from 'react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import styled from 'styled-components';
import { effectFetch } from '../helpers/effectFetch';
import { useAISettings } from '@components/AI/AISettingsContext';
import { Main } from '@components/Main';

export type LinkOpenRouterSearch = {
  code: string;
};

const ENDPOINT = 'https://openrouter.ai/api/v1/auth/keys';

export const LinkOpenRouter = createRoute({
  path: pathNames.linkOpenRouter,
  component: () => <LinkOpenRouterPage />,
  getParentRoute: () => appRoute,
  validateSearch: (search): LinkOpenRouterSearch => ({
    code: (search.code as string) ?? '',
  }),
});

function LinkOpenRouterPage() {
  const [error, setError] = useState<string>();
  const { setOpenRouterApiKey } = useAISettings();
  const { code } = LinkOpenRouter.useSearch();
  const navigate = useNavigateWithTransition();

  const setCodeAndNavigate = useEffectEvent((key: string) => {
    setOpenRouterApiKey(key);
    sessionStorage.removeItem('atomic.ai.openrouter-code-verifier');
    sessionStorage.removeItem('atomic.ai.openrouter-code-challenge');
    sessionStorage.setItem('atomic.ai.openSetup', 'true');

    navigate({ to: pathNames.app });
  });

  const codeVerifier = sessionStorage.getItem(
    'atomic.ai.openrouter-code-verifier',
  );

  useEffect(() => {
    if (!codeVerifier) return;

    return effectFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: code,
        code_verifier: codeVerifier,
        code_challenge_method: 'S256',
      }),
    })(
      ({ key }) => {
        setCodeAndNavigate(key);
      },
      err => {
        setError(err.message);
      },
    );
  }, [code, codeVerifier]);

  const displayError = !codeVerifier ? 'No code verifier found' : error;

  if (displayError) {
    return (
      <Center>
        <div>
          <h1>Error</h1>
          <p>{displayError}</p>
        </div>
      </Center>
    );
  }

  return (
    <Main>
      <Center>
        <div>
          <h1>Linking OpenRouter</h1>
          <p>Please wait while we link your OpenRouter account...</p>
        </div>
      </Center>
    </Main>
  );
}

const Center = styled.div`
  display: grid;
  height: 100%;
  width: 100%;
  place-items: center;
`;
