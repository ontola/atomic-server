import * as React from 'react';
import { useState } from 'react';
import { Agent, server } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import {
  InputStyled,
  InputWrapper,
  LabelStyled,
} from '../components/forms/InputStyles';
import { Button } from '../components/Button';
import { Margin } from '../components/Card';
import Field from '../components/forms/Field';
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
import { FaKey, FaUser } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { NewIdentitySection } from '../components/NewIdentitySection';
import { DrivesCard } from './SettingsServer/DrivesCard';
import { useSavedDrives } from '../hooks/useSavedDrives';
import { useDriveHistory } from '../hooks/useDriveHistory';
import { constructOpenURL } from '../helpers/navigation';

export const AgentSettingsRoute = createRoute({
  path: pathNames.agentSettings,
  component: () => <SettingsAgent />,
  getParentRoute: () => appRoute,
});

const SettingsAgent: React.FunctionComponent = () => {
  const { agent, setAgent, setDrive } = useSettings();
  const [error, setError] = useState<Error | undefined>(undefined);
  const navigate = useNavigateWithTransition();
  const [showCreate, setShowCreate] = useState(false);

  const [savedDrives] = useSavedDrives();
  const [, addToHistory] = useDriveHistory(savedDrives);

  function handleSignOut() {
    setAgent(undefined);
    setError(undefined);
    saveAgentToIDB(undefined);
  }

  async function handleUpdateSecret(updateSecret: string) {
    setError(undefined);

    try {
      const newAgent = await Agent.fromSecret(updateSecret);

      setAgent(newAgent);
      saveAgentToIDB(updateSecret);
    } catch (e) {
      const err = new Error('Invalid secret. ' + e);
      setError(err);
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
        <h1>{agent ? 'User Settings' : 'Login / New User'}</h1>
        {showCreate ? (
          <NewIdentitySection autoStart onDone={() => setShowCreate(false)} />
        ) : agent ? (
          <Column>
            {agent.subject?.startsWith('http://localhost') && (
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
              <ResourceInline subject={agent.subject!} />
            </div>
            <Row>
              <Button onClick={() => navigate(editURL(agent.subject!))}>
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
        ) : (
          <Column gap='2rem'>
            <Column gap='1rem'>
              <h3>Create a new identity</h3>
              <p>
                Generate a new self-sovereign Agent and Drive on this server.
              </p>
              <Button onClick={() => setShowCreate(true)}>
                Create new identity
              </Button>
            </Column>
            <Divider />
            <Column gap='1rem'>
              <h3>Sign in with existing secret</h3>
              <Field
                label='Enter your Agent Secret'
                helper={
                  "The Agent Secret is a long string of characters that encodes both the Subject and the Private Key. You can think of it as a combined username + password. Store it safely, and don't share it with others."
                }
                error={error}
              >
                <InputWrapper hasPrefix>
                  <FaKey />
                  <InputStyled
                    onChange={e => handleUpdateSecret(e.target.value)}
                    type='password'
                    disabled={agent !== undefined}
                    name='secret'
                    id='current-password'
                    autoComplete='current-password'
                    spellCheck='false'
                  />
                </InputWrapper>
              </Field>
            </Column>
          </Column>
        )}
      </ContainerNarrow>
    </Main>
  );
};

const Divider = styled.hr`
  width: 100%;
  border: none;
  border-top: 1px solid ${p => p.theme.colors.bg2};
  margin: 0;
`;

const Heading = styled.h1`
  margin: 0;
`;
