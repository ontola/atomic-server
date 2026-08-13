import { useEffect, type JSX } from 'react';
import { createRoute } from '@tanstack/react-router';
import { appRoute } from './RootRoutes';
import { pathNames, paths } from './paths';
import { useSettings } from '../helpers/AppSettings';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { Main } from '../components/Main';
import { ContainerWide } from '../components/Containers';
import { NewDriveSetup } from '../components/Drives/NewDriveSetup';

export const NewDriveRoute = createRoute({
  path: pathNames.newDrive,
  getParentRoute: () => appRoute,
  component: () => <NewDrivePage />,
});

// Reached from the managed portal's dashboard ("+ New drive"). The drive is
// created *here* rather than in the portal because the portal only ever holds
// a session cookie, never the agent's private key.
//
// It creates the drive and stops there. It used to also enroll the new drive
// in Cloud Server, which was right when hosting was what every account got and
// is wrong now: Cloud Server is the paid tier, and the default is a local-first
// drive with encrypted backup offered from the Sync page like any other drive.
function NewDrivePage(): JSX.Element {
  const { agent } = useSettings();
  const navigate = useNavigateWithTransition();

  useEffect(() => {
    if (!agent) {
      navigate(paths.welcome);
    }
  }, [agent, navigate]);

  return (
    <Main>
      <ContainerWide>
        <h1>New drive</h1>
        <NewDriveSetup showCancel={false} createLabel='Create drive' />
      </ContainerWide>
    </Main>
  );
}
