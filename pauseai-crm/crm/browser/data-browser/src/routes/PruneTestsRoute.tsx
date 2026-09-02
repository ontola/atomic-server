import { Resource, Server, useStore } from '@tomic/react';
import { useState } from 'react';
import { Button } from '../components/Button';
import { ContainerFull } from '../components/Containers';
import { Column } from '../components/Row';
import { createLazyRoute } from '@tanstack/react-router';
import { DEV_DRIVE_PRUNE_MARKER } from '../hooks/useDevDrive';

const PruneTestsRoute: React.FC = () => {
  const store = useStore();
  const [result, setResult] = useState<Resource<Server.EndpointResponse>>();
  const [isWaiting, setIsWaiting] = useState(false);

  const postPruneTest = async () => {
    setIsWaiting(true);
    const url = new URL('/prunetests', store.getServerUrl());
    const res = await store.postToServer(url.toString());
    setIsWaiting(false);
    setResult(res);
  };

  return (
    <main>
      <ContainerFull>
        <h1>Prune Test Data</h1>
        <p>
          This removes drives created for automated tests or local dev: names
          containing <code>testdrive-</code> (E2E), or descriptions containing{' '}
          <code>{DEV_DRIVE_PRUNE_MARKER}</code> (from{' '}
          <code>/app/dev-drive</code>).
        </p>
        <Column>
          <Button onClick={postPruneTest} disabled={isWaiting} alert>
            Prune
          </Button>
          {isWaiting && <p>Pruning, this might take a while...</p>}
          <p data-testid='prune-result'>
            {result && `✅ ${result.props.responseMessage}`}
          </p>
        </Column>
      </ContainerFull>
    </main>
  );
};

export const pruneTestRouteLazy = createLazyRoute('/app/prunetests')({
  component: PruneTestsRoute,
});
