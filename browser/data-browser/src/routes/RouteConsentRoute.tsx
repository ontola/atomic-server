import { createRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import {
  errorMessageFromResponse,
  signRequest,
  useStore,
  type Agent,
} from '@tomic/react';
import { Main } from '../components/Main';
import { ContainerNarrow } from '../components/Containers';
import { Column, Row } from '../components/Row';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { SimpleErrorBlock } from '../components/ErrorLook';
import { useSettings } from '../helpers/AppSettings';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';

/**
 * `/app/route-consent?request=<id>`: the host's consent page for a plugin
 * route's token (design `server-plugin-routes.md`, D6). A plugin never serves
 * a login or consent form: its route asks the server for a consent request and
 * sends the browser here. Someone who may manage the plugin approves or denies,
 * and the browser goes back to the plugin's route with a one-time code.
 */
export const RouteConsentRoute = createRoute({
  path: pathNames.routeConsent,
  component: () => <RouteConsentPage />,
  getParentRoute: () => appRoute,
  validateSearch: (search): { request: string } => ({
    request: typeof search.request === 'string' ? search.request : '',
  }),
});

interface Ask {
  plugin: string;
  installation: string;
  drive?: string;
  token: { name: string; reason?: string };
  scopes: string[];
  client?: string;
  redirectOrigin: string;
  expiresAt: number;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Signed with Atomic headers over the exact URL, so a signature answers this
 * request and nothing else. Shaped as a result rather than an exception: the
 * React Compiler cannot compile try/catch inside a component.
 */
async function call<T>(
  url: string,
  agent: Agent,
  method: 'GET' | 'POST',
): Promise<Result<T>> {
  try {
    const headers = await signRequest(url, agent, {});
    const response = await fetch(url, { method, headers });
    const body = await response.text();

    if (!response.ok) {
      return { ok: false, error: errorMessageFromResponse(body, response.status) };
    }

    return { ok: true, value: JSON.parse(body) as T };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function RouteConsentPage() {
  const store = useStore();
  const { agent } = useSettings();
  const { request } = RouteConsentRoute.useSearch();
  const [ask, setAsk] = useState<Ask>();
  const [error, setError] = useState<string>();
  const [answering, setAnswering] = useState<'approve' | 'deny'>();

  const url = `${store.getServerUrl()}/plugin-route-consent?request=${encodeURIComponent(request)}`;

  useEffect(() => {
    if (!agent || !request) return;

    let cancelled = false;

    call<Ask>(url, agent, 'GET').then(result => {
      if (cancelled) return;

      if (result.ok) {
        setAsk(result.value);
      } else {
        setError(result.error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [agent, request, url]);

  const answer = async (decision: 'approve' | 'deny') => {
    if (!agent) return;

    setAnswering(decision);
    const result = await call<{ redirect: string }>(
      `${url}&decision=${decision}`,
      agent,
      'POST',
    );

    if (result.ok) {
      window.location.assign(result.value.redirect);
    } else {
      setAnswering(undefined);
      setError(result.error);
    }
  };

  let content: React.ReactNode;

  if (!request) {
    content = (
      <SimpleErrorBlock>
        This link is incomplete. Start again from the app that sent you here.
      </SimpleErrorBlock>
    );
  } else if (!agent) {
    content = <p>Sign in to answer this request.</p>;
  } else if (error) {
    content = <SimpleErrorBlock role='alert'>{error}</SimpleErrorBlock>;
  } else if (!ask) {
    content = <p>Loading the request…</p>;
  } else {
    content = (
      <>
        {ask.client ? (
          <p>
            <strong>{ask.plugin}</strong> asks to give{' '}
            <strong>{ask.client}</strong> a token for its{' '}
            <Code>{ask.token.name}</Code> endpoints.
          </p>
        ) : (
          <p>
            <strong>{ask.plugin}</strong> asks to issue a token for its{' '}
            <Code>{ask.token.name}</Code> endpoints.
          </p>
        )}
        {ask.token.reason && <Reason>{ask.token.reason}</Reason>}
        <Card>
          <Column gap='0.5rem'>
            <strong>With these permissions</strong>
            {ask.scopes.length === 0 ? (
              <span>No specific permissions.</span>
            ) : (
              <Scopes>
                {ask.scopes.map(scope => (
                  <li key={scope}>
                    <Code>{scope}</Code>
                  </li>
                ))}
              </Scopes>
            )}
          </Column>
        </Card>
        <Muted>
          You can revoke the token later from the plugin. After you answer,
          you go back to {ask.redirectOrigin}.
        </Muted>
        <Row gap='0.5rem'>
          <Button
            onClick={() => answer('approve')}
            loading={answering === 'approve' ? 'Allowing…' : undefined}
            disabled={answering !== undefined}
          >
            Allow
          </Button>
          <Button
            subtle
            onClick={() => answer('deny')}
            loading={answering === 'deny' ? 'Denying…' : undefined}
            disabled={answering !== undefined}
          >
            Deny
          </Button>
        </Row>
      </>
    );
  }

  return (
    <Main>
      <ContainerNarrow>
        <Column>
          <h1>Allow access?</h1>
          {content}
        </Column>
      </ContainerNarrow>
    </Main>
  );
}

const Code = styled.code`
  font-family: monospace;
  overflow-wrap: anywhere;
`;

const Scopes = styled.ul`
  margin: 0;
  padding-left: 1.2rem;
`;

const Reason = styled.p`
  font-style: italic;
`;

const Muted = styled.p`
  color: ${p => p.theme.colors.textLight};
`;
