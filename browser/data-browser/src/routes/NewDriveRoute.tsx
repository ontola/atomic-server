import { createRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState, type JSX } from 'react';
import { appRoute } from './RootRoutes';
import { pathNames, paths } from './paths';
import { useSettings } from '../helpers/AppSettings';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { useCreateDrive } from '../hooks/useCreateDrive';
import { Shell, Card, CardTitle } from '../views/getting-started/chrome';
import { Button } from '../components/Button';
import { Column } from '../components/Row';
import { ErrorBlock } from '../components/ErrorLook';

export const NewDriveRoute = createRoute({
  path: pathNames.newDrive,
  getParentRoute: () => appRoute,
  component: () => <NewDrivePage />,
});

// Reached from the managed portal's dashboard ("+ New drive"). The drive is
// created *here* rather than in the portal because the portal only ever holds
// a session cookie, never the agent's private key. It makes the drive on load
// and opens it, empty; the drive page offers what to put in it.
function NewDrivePage(): JSX.Element {
  const { agent } = useSettings();
  const navigate = useNavigateWithTransition();
  const createDrive = useCreateDrive();
  const started = useRef(false);
  const [error, setError] = useState<Error>();

  function create() {
    setError(undefined);
    createDrive().catch(e =>
      setError(e instanceof Error ? e : new Error(String(e))),
    );
  }

  useEffect(() => {
    if (!agent) {
      navigate(paths.welcome);

      return;
    }

    if (started.current) return;
    started.current = true;
    create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  if (!agent) return <Shell />;

  return (
    <Shell>
      <Card>
        <CardTitle>New drive</CardTitle>
        {error ? (
          <Column>
            <ErrorBlock error={error} />
            <Button onClick={create}>Try again</Button>
          </Column>
        ) : (
          <p>Creating your drive…</p>
        )}
      </Card>
    </Shell>
  );
}
