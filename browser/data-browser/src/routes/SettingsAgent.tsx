import * as React from 'react';
import { useEffect, useId, useState } from 'react';
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
import { FaCircleInfo, FaUser } from 'react-icons/fa6';
import { styled } from 'styled-components';
import {
  InputStyled,
  InputWrapper,
  LabelStyled,
} from '../components/forms/InputStyles';
import { ErrorLook } from '../components/ErrorLook';
import { DrivesCard } from '../components/Drives/DrivesCard';
import { useSavedDrives } from '../hooks/useSavedDrives';
import { useDriveHistory } from '../hooks/useDriveHistory';
import { usePersonalDrive } from '../hooks/usePersonalDrive';
import { constructOpenURL } from '../helpers/navigation';
import { paths } from './paths';
import { logoutManagedSession } from '../helpers/managed';

export const AgentSettingsRoute = createRoute({
  path: pathNames.agentSettings,
  component: () => <SettingsAgent />,
  getParentRoute: () => appRoute,
});

const SettingsAgent: React.FunctionComponent = () => {
  const store = useStore();
  const { agent, drive, setAgent, setDrive } = useSettings();
  // Sometimes the settings context can briefly lag behind the store on first
  // navigation. Fall back to the store-backed hook to avoid flashing the
  // logged-out panel for signed-in users.
  const [storeAgent] = useCurrentAgent();
  const effectiveAgent = agent ?? storeAgent ?? store.getAgent();
  const navigate = useNavigateWithTransition();

  const { personalDrive } = usePersonalDrive();
  const [savedDrives] = useSavedDrives();
  const [history, addToHistory, removeFromHistory] =
    useDriveHistory(savedDrives);

  // The private drive gets its own section; keep it out of the lists.
  const myDrives = savedDrives.filter(subject => subject !== personalDrive);
  const recentDrives = history.filter(subject => subject !== personalDrive);

  const driveUrlId = useId();
  const [driveInput, setDriveInput] = useState('');
  const [driveErr, setDriveErr] = useState<Error | undefined>();

  // Signed out → there is a single canonical sign-in / onboarding surface at
  // /app/welcome (GettingStartedFlow). Redirect there rather than rendering a
  // second, parallel login form on this settings page.
  useEffect(() => {
    if (!effectiveAgent) {
      navigate({ to: paths.welcome, replace: true });
    }
  }, [effectiveAgent]);

  function handleSignOut() {
    const currentDrive = drive;

    // Everything that makes the UI say "signed out" happens now, synchronously.
    // `store.setAgent` drives a `useSyncExternalStore`, so the app re-renders
    // this tick; the private workspace is no longer readable, so clear the
    // active drive rather than leave it on screen; and go to the one sign-in
    // surface. This used to sit behind an `await getResource` that a public
    // drive skipped entirely, so signing out did nothing visible until a
    // refresh re-read the (now empty) agent.
    setAgent(undefined);
    // Empty, not the server origin: a drive is a workspace, and the origin is
    // the pre-DID default standing in for one. Signed out, there is no
    // workspace — say that, don't fall back to the server's own.
    setDrive('');
    navigate({ to: paths.welcome, replace: true });

    // The rest is cleanup the user should never wait on: persist the cleared
    // agent, and end the control-plane session so signing out here signs out
    // of a managed account too (no-op when self-hosted).
    saveAgentToIDB(undefined);
    void logoutManagedSession();

    // Best-effort: if the drive we just left was private, forget it from
    // history too, so it does not reappear as a suggestion to a signed-out
    // browser. Failure here changes nothing the user can see.
    void store
      .getResource(currentDrive)
      .then(driveResource => {
        const readRight = driveResource.get(core.properties.read);
        const readArray = Array.isArray(readRight) ? readRight : [];

        if (!readArray.includes(urls.instances.publicAgent)) {
          removeFromHistory?.(currentDrive);
        }
      })
      .catch(() => undefined);
  }

  function handleSetDrive(url: string) {
    setDrive(url);
    addToHistory(url);
    navigate(constructOpenURL(url));
  }

  function handleOpenDriveInput() {
    try {
      handleSetDrive(driveInput);
    } catch (e) {
      setDriveErr(e as Error);
    }
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

              {personalDrive && (
                <>
                  <Row center gap='1ch'>
                    <Heading as='h2'>Private drive</Heading>
                    <InfoHint title='Your personal space — only visible to you.' />
                  </Row>
                  <DrivesCard
                    hideFavorite
                    drives={[personalDrive]}
                    onDriveSelect={handleSetDrive}
                  />
                </>
              )}

              <Row center gap='1ch'>
                <Heading as='h2'>My drives</Heading>
                <InfoHint title='Unstar a drive to move it back to recently visited.' />
              </Row>
              <DrivesCard
                showNewOption
                drives={myDrives}
                onDriveSelect={handleSetDrive}
              />

              {recentDrives.length > 0 && (
                <>
                  <Row center gap='1ch'>
                    <Heading as='h2'>Recently visited</Heading>
                    <InfoHint title='Only stored on this device. Star a drive to keep it in My drives.' />
                  </Row>
                  <DrivesCard
                    drives={recentDrives}
                    onDriveSelect={handleSetDrive}
                    onDriveRemove={removeFromHistory}
                  />
                </>
              )}

              <div>
                <LabelStyled htmlFor={driveUrlId}>
                  Open a drive by URL or DID
                </LabelStyled>
                <Row>
                  <InputWrapper>
                    <InputStyled
                      id={driveUrlId}
                      data-testid='drive-url-input'
                      value={driveInput}
                      onChange={e => setDriveInput(e.target.value)}
                      placeholder='Enter a Drive DID or URL'
                    />
                  </InputWrapper>
                  <Button
                    onClick={handleOpenDriveInput}
                    disabled={!driveInput || drive === driveInput}
                    data-test='drive-url-save'
                  >
                    Open
                  </Button>
                </Row>
                {driveErr && <ErrorLook>{driveErr.message}</ErrorLook>}
              </div>
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

/** Hover-for-details icon next to a section heading, replacing hint prose. */
function InfoHint({ title }: { title: string }) {
  return (
    <InfoHintIcon title={title}>
      <FaCircleInfo aria-label={title} />
    </InfoHintIcon>
  );
}

const InfoHintIcon = styled.span`
  display: inline-flex;
  align-items: center;
  color: ${p => p.theme.colors.textLight};
  cursor: help;
  font-size: 0.9rem;
`;
