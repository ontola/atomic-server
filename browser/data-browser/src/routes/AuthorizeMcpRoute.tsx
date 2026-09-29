import { useState } from 'react';
import { createRoute } from '@tanstack/react-router';
import { grantAgent, useStore } from '@tomic/react';
import { styled } from 'styled-components';
import { Button } from '../components/Button';
import { Margin } from '../components/Card';
import { ConnectDrivePicker } from '../components/ConnectDrivePicker';
import { ContainerNarrow } from '../components/Containers';
import { ErrorLook } from '../components/ErrorLook';
import { Main } from '../components/Main';
import { Column, Row } from '../components/Row';
import { useSettings } from '../helpers/AppSettings';
import { rememberConnectedApp } from '../helpers/connectedApps';
import { approveAuthorization, requestIssuedAgent } from '../helpers/hostedMcp';
import { useAccountDriveCatalog } from '../hooks/useAccountDriveCatalog';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { usePrivateDrive } from '../hooks/usePrivateDrive';
import { useSavedDrives } from '../hooks/useSavedDrives';
import { pathNames, paths } from './paths';
import { appRoute } from './RootRoutes';

export interface AuthorizeMcpSearch {
  server: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * /app/authorize-mcp?server=&client_id=&client_name=&redirect_uri=&code_challenge=[&state=]
 *
 * Where a person lets an MCP client that runs elsewhere (claude.ai, for one)
 * read their data. The node's `/oauth/authorize` sends the browser here. On
 * Allow the app asks the node for an identity for that client, gives it read
 * rights on the drives picked, and sends the browser back to the client. The
 * client can only read, and only what is picked here; revoke it under
 * Connected apps in account settings.
 */
export const AuthorizeMcpRoute = createRoute({
  path: pathNames.authorizeMcp,
  component: () => <AuthorizeMcpPage />,
  getParentRoute: () => appRoute,
  validateSearch: (search): AuthorizeMcpSearch => ({
    server: text(search.server),
    client_id: text(search.client_id),
    client_name: text(search.client_name),
    redirect_uri: text(search.redirect_uri),
    code_challenge: text(search.code_challenge),
    state: text(search.state) || undefined,
  }),
});

function hostOf(uri: string): string | undefined {
  try {
    const url = new URL(uri);

    return url.host || url.protocol;
  } catch {
    return undefined;
  }
}

function AuthorizeMcpPage() {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const { agent, drive } = useSettings();
  const search = AuthorizeMcpRoute.useSearch();
  const { privateDrive, loading: homeLoading } = usePrivateDrive();
  const [savedDrives] = useSavedDrives();
  const catalog = useAccountDriveCatalog(
    privateDrive ? [privateDrive, ...savedDrives] : savedDrives,
  );
  const [picked, setPicked] = useState<string[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const name = search.client_name.trim() || 'An app';
  const host = hostOf(search.redirect_uri);
  const selected =
    picked ?? (drive && catalog.subjects.includes(drive) ? [drive] : []);
  const complete =
    search.server &&
    search.client_id &&
    search.redirect_uri &&
    search.code_challenge;

  if (!complete || !host) {
    return (
      <Page>
        <h1>Connect an app</h1>
        <p>
          This link is incomplete. Start again from the app that sent you here.
        </p>
      </Page>
    );
  }

  if (!agent?.subject) {
    return (
      <Page>
        <h1>Connect an app</h1>
        <p>Sign in first, then open this link again.</p>
        <Button onClick={() => navigate(paths.welcome)}>Sign in</Button>
      </Page>
    );
  }

  const toggle = (subject: string, on: boolean) =>
    setPicked(
      on
        ? [...selected, subject]
        : selected.filter(existing => existing !== subject),
    );

  async function handleAllow() {
    setBusy(true);
    setError(undefined);

    try {
      const home = privateDrive ?? drive;

      if (!home) {
        throw new Error('Open one of your drives first.');
      }

      const issued = await requestIssuedAgent(
        store,
        search.server,
        search.client_id,
      );

      await grantAgent(store, issued.agent, selected, false);
      await rememberConnectedApp(store, home, issued.agent);

      const redirect = await approveAuthorization(store, search.server, {
        clientId: search.client_id,
        redirectUri: search.redirect_uri,
        codeChallenge: search.code_challenge,
        nonce: issued.nonce,
        state: search.state,
      });

      // Away from the app: the client takes over from here.
      window.location.assign(redirect);

      return;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }

    setBusy(false);
  }

  return (
    <Page>
      <h1>Connect an app</h1>
      <p>
        <strong data-test='authorize-mcp-name'>{name}</strong> asks to read your
        Atomic data. After you allow it, you go back to {host}. It gets its own
        access, so your secret stays with you, and you can revoke it at any
        time.
      </p>

      <Column>
        <Heading>What it can read</Heading>
        <ConnectDrivePicker
          subjects={catalog.subjects}
          selected={selected}
          onToggle={toggle}
        />
        <p>It can read only. It cannot change or delete anything.</p>

        <Margin />
        {error && <ErrorLook>{error}</ErrorLook>}
        <Row>
          <Button
            onClick={handleAllow}
            disabled={busy || homeLoading || selected.length === 0}
            loading={busy ? 'Connecting' : undefined}
            data-test='authorize-mcp-allow'
          >
            Allow
          </Button>
          <Button subtle onClick={() => navigate(paths.agentSettings)}>
            Cancel
          </Button>
        </Row>
      </Column>
    </Page>
  );
}

function Page({ children }: React.PropsWithChildren) {
  return (
    <Main>
      <ContainerNarrow>{children}</ContainerNarrow>
    </Main>
  );
}

const Heading = styled.h2`
  margin: 0;
  font-size: 1.1rem;
`;
