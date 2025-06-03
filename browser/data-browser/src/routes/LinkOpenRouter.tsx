import { createRoute } from '@tanstack/react-router';
import { pathNames, paths } from './paths';
import { appRoute } from './RootRoutes';
import { useEffect, useState } from 'react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import styled from 'styled-components';
import { useSettings } from '../helpers/AppSettings';

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
  const { setOpenRouterApiKey } = useSettings();
  const { code } = LinkOpenRouter.useSearch();
  const navigate = useNavigateWithTransition();

  useEffect(() => {
    const codeVerifier = sessionStorage.getItem(
      'atomic.ai.openrouter-code-verifier',
    );

    if (!codeVerifier) {
      setError('No code verifier found');

      return;
    }

    fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: code,
        code_verifier: codeVerifier,
        code_challenge_method: 'S256',
      }),
    })
      .then(res => res.json())
      .then(({ key }) => {
        setOpenRouterApiKey(key);
        sessionStorage.removeItem('atomic.ai.openrouter-code-verifier');
        sessionStorage.removeItem('atomic.ai.openrouter-code-challenge');

        navigate({ to: paths.appSettings });
      })
      .catch(err => {
        setError(err.message);
      });
  }, [code]);

  if (error) {
    return (
      <Center>
        <div>
          <h1>Error</h1>
          <p>{error}</p>
        </div>
      </Center>
    );
  }

  return (
    <Center>
      <div>
        <h1>Linking OpenRouter</h1>
        <p>Please wait while we link your OpenRouter account...</p>
      </div>
    </Center>
  );
}

const Center = styled.div`
  display: grid;
  height: 100%;
  width: 100%;
  place-items: center;
`;
