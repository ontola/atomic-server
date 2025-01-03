import * as React from 'react';
import { ContainerNarrow } from '../components/Containers';
import { CodeBlock } from '../components/CodeBlock';
import { createAuthentication, useServerURL } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { Main } from '../components/Main';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import { createRoute } from '@tanstack/react-router';

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
  }, [agent]);

  return (
    <Main>
      <ContainerNarrow>
        <CodeBlock content={token} />
      </ContainerNarrow>
    </Main>
  );
};
