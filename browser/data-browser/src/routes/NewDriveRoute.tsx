import { createRoute } from '@tanstack/react-router';
import { useEffect, type JSX } from 'react';
import { appRoute } from './RootRoutes';
import { pathNames, paths } from './paths';
import { useSettings } from '../helpers/AppSettings';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../helpers/navigation';
import { Shell, Card, CardTitle } from '../views/getting-started/chrome';
import { NewDriveForm } from '../components/forms/NewForm/CustomCreateActions/CustomForms/NewDriveDialog';

export const NewDriveRoute = createRoute({
  path: pathNames.newDrive,
  getParentRoute: () => appRoute,
  component: () => <NewDrivePage />,
});

// Reached from the managed portal's dashboard ("+ New drive"). The drive is
// created *here* rather than in the portal because the portal only ever holds
// a session cookie, never the agent's private key. It asks for a name, makes
// the drive and opens it, empty; the drive page offers what to put in it.
function NewDrivePage(): JSX.Element {
  const { agent, drive, setDrive } = useSettings();
  const navigate = useNavigateWithTransition();
  useEffect(() => {
    if (!agent) navigate(paths.welcome);
  }, [agent, navigate]);
  if (!agent) return <Shell />;

  return (
    <Shell>
      <Card>
        <CardTitle>New drive</CardTitle>
        <NewDriveForm
          onCreated={resource => {
            setDrive(resource.subject);
            navigate(constructOpenURL(resource.subject));
          }}
          onCancel={drive ? () => navigate(constructOpenURL(drive)) : undefined}
        />
      </Card>
    </Shell>
  );
}
