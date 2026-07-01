import { createRoute } from '@tanstack/react-router';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import { useEffect, useEffectEvent, useState } from 'react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import styled from 'styled-components';
import { useAISettings } from '@components/AI/AISettingsContext';
import { Main } from '@components/Main';

export type LinkOpenRouterSearch = {
  code: string;
};

const ENDPOINT = 'https://openrouter.ai/api/v1/auth/keys';

const VERIFIER_KEY = 'atomic.ai.openrouter-code-verifier';

// OpenRouter authorization codes are single-use. React StrictMode (and any
// re-render) would otherwise fire the exchange twice, and the second request
// fails because the first already consumed the code. This module-level guard
// makes sure each code is exchanged at most once for the lifetime of the page.
const exchangedCodes = new Set<string>();

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
    localStorage.removeItem(VERIFIER_KEY);
    sessionStorage.setItem('atomic.ai.openSetup', 'true');

    navigate({ to: pathNames.app });
  });

  const codeVerifier = localStorage.getItem(VERIFIER_KEY);

  useEffect(() => {
    if (!codeVerifier || !code) return;

    // Guard against the single-use code being exchanged more than once.
    if (exchangedCodes.has(code)) return;

    exchangedCodes.add(code);

    // The `exchangedCodes` guard already ensures this runs once, so the request
    // is intentionally not aborted on cleanup: aborting an in-flight request can
    // still let it reach OpenRouter and burn the single-use code. Letting it run
    // to completion means the success path always fires, even across StrictMode's
    // simulated unmount/remount in dev.
    (async () => {
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            code,
            code_verifier: codeVerifier,
            code_challenge_method: 'S256',
          }),
        });

        const data = await response.json().catch(() => undefined);

        if (!response.ok || !data?.key) {
          throw new Error(
            data?.error?.message ??
              data?.error ??
              'OpenRouter did not return an API key.',
          );
        }

        setCodeAndNavigate(data.key);
      } catch (err) {
        // Allow another attempt with a fresh code after a failure.
        exchangedCodes.delete(code);
        setError((err as Error).message);
      }
    })();
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
