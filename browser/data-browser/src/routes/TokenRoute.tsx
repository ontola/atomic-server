import * as React from 'react';
import { ContainerNarrow } from '../components/Containers';
import { CodeBlock } from '../components/CodeBlock';
import { createAuthentication, useServerURL } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { Main } from '../components/Main';
import { pathNames, paths } from './paths';
import { appRoute } from './RootRoutes';
import { createRoute } from '@tanstack/react-router';
import { WarningBlock } from '../components/WarningBlock';
import { Column } from '../components/Row';
import { AtomicLink } from '../components/AtomicLink';

export const TokenRoute = createRoute({
  path: pathNames.token,
  component: () => <TokenRoutePage />,
  getParentRoute: () => appRoute,
});

/** Lets user create bearer tokens */
const TokenRoutePage: React.FunctionComponent = () => {
  const [token, setToken] = React.useState('');
  const { agent } = useSettings();
  const [server] = useServerURL();

  React.useEffect(() => {
    async function getToken() {
      if (agent) {
        const json = await createAuthentication(server, agent);
        setToken(btoa(JSON.stringify(json)));
      }
    }

    getToken();
  }, [agent, server]);

  return (
    <Main>
      <ContainerNarrow>
        <Column gap='1rem'>
          <WarningBlock>
            <WarningBlock.Title>
              This signs in as you, with all of your rights.
            </WarningBlock.Title>
            It is a short-lived session for a personal CLI — not a scoped key
            for an app. For Raycast, a plugin, or anything that should not hold
            your account secret, create an app key in{' '}
            <AtomicLink path={paths.agentSettings}>User Settings</AtomicLink>.
          </WarningBlock>
          <CodeBlock content={token} />
        </Column>
      </ContainerNarrow>
    </Main>
  );
};
