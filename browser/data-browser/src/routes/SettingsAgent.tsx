import * as React from 'react';
import { useEffect } from 'react';
import { core, urls, useCurrentAgent, useStore } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { Button } from '../components/Button';
import { Margin } from '../components/Card';
import { ResourceInline } from '../views/ResourceInline';
import { ContainerNarrow } from '../components/Containers';
import { editURL } from '../helpers/navigation';
import { Main } from '../components/Main';
import { Column, Row } from '../components/Row';
import { WarningBlock } from '../components/WarningBlock';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { createRoute } from '@tanstack/react-router';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import { saveAgentToIDB } from '@helpers/agentStorage';
import { FaUser } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { LabelStyled } from '../components/forms/InputStyles';
import { DrivesCard } from './SettingsServer/DrivesCard';
import { useSavedDrives } from '../hooks/useSavedDrives';
import { useDriveHistory } from '../hooks/useDriveHistory';
import { constructOpenURL } from '../helpers/navigation';
import { paths } from './paths';

export const AgentSettingsRoute = createRoute({
  path: pathNames.agentSettings,
  component: () => <SettingsAgent />,
  getParentRoute: () => appRoute,
});

const SettingsAgent: React.FunctionComponent = () => {
  const store = useStore();
  const { agent, drive, baseURL, setAgent, setDrive } = useSettings();
  // Sometimes the settings context can briefly lag behind the store on first
  // navigation. Fall back to the store-backed hook to avoid flashing the
  // logged-out panel for signed-in users.
  const [storeAgent] = useCurrentAgent();
  const effectiveAgent = agent ?? storeAgent ?? store.getAgent();
  const navigate = useNavigateWithTransition();

  const [savedDrives] = useSavedDrives();
  const [, addToHistory] = useDriveHistory(savedDrives);

  // Signed out → there is a single canonical sign-in / onboarding surface at
  // /app/welcome (GettingStartedFlow). Redirect there rather than rendering a
  // second, parallel login form on this settings page.
  useEffect(() => {
    if (!effectiveAgent) {
      navigate({ to: paths.welcome, replace: true });
    }
  }, [effectiveAgent]);

  async function handleSignOut() {
    const currentDrive = drive;

    setAgent(undefined);
    saveAgentToIDB(undefined);

    try {
      const driveResource = await store.getResource(currentDrive);
      const readRight = driveResource.get(core.properties.read);
      const readArray = Array.isArray(readRight) ? readRight : [];
      const isPublic = readArray.includes(urls.instances.publicAgent);

      if (!isPublic) {
        // The private drive is no longer readable signed-out — don't leave it
        // lingering as the active drive. Reset to the public server root.
        setDrive(baseURL || '');
        navigate({ to: paths.welcome, replace: true });
      }
    } catch {
      // If we can't determine visibility, default to welcome + server root.
      setDrive(baseURL || '');
      navigate({ to: paths.welcome, replace: true });
    }
  }

  function handleSetDrive(url: string) {
    setDrive(url);
    addToHistory(url);
    navigate(constructOpenURL(url));
  }

  return (
    <Main>
      <ContainerNarrow>
        {effectiveAgent ? (
          <>
            <h1>User Settings</h1>
            <Column>
              {effectiveAgent.subject?.startsWith('http://localhost') && (
                <WarningBlock>
                  <WarningBlock.Title>Warning:</WarningBlock.Title>
                  {
                    "You're using a local Agent, which cannot authenticate on other domains, because its URL does not resolve."
                  }
                </WarningBlock>
              )}
              <div>
                <LabelStyled>
                  <FaUser /> You{"'"}re signed in as
                </LabelStyled>
                <ResourceInline subject={effectiveAgent.subject!} />
              </div>
              <Row>
                <Button
                  onClick={() => navigate(editURL(effectiveAgent.subject!))}
                >
                  Edit profile
                </Button>
                <Button
                  subtle
                  title='Sign out with current Agent and reset this form'
                  onClick={handleSignOut}
                  data-test='sign-out'
                >
                  Sign Out
                </Button>
              </Row>

              <Margin />

              <Heading as='h2'>Drives</Heading>
              <DrivesCard
                showNewOption
                drives={savedDrives}
                onDriveSelect={handleSetDrive}
              />
            </Column>
          </>
        ) : null}
      </ContainerNarrow>
    </Main>
  );
};

const Heading = styled.h1`
  margin: 0;
`;
