import * as React from 'react';
import { useState } from 'react';
import { Agent } from '@tomic/react';
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
import { AtomicLink } from '../components/AtomicLink';
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

export const AgentSettingsRoute = createRoute({
  path: pathNames.agentSettings,
  component: () => <SettingsAgent />,
  getParentRoute: () => appRoute,
});

const SettingsAgent: React.FunctionComponent = () => {
  const { agent, setAgent } = useSettings();
  const [error, setError] = useState<Error | undefined>(undefined);
  const navigate = useNavigateWithTransition();

  function handleSignOut() {
    setAgent(undefined);
    setError(undefined);
    saveAgentToIDB(undefined);
  }

  /** When the Secret updates, parse it and try if the */
  async function handleUpdateSecret(updateSecret: string) {
    setError(undefined);

    try {
      const newAgent = await Agent.fromSecret(updateSecret);

      setAgent(newAgent);
      saveAgentToIDB(updateSecret);
      // This will fail and throw if the agent is not public, which is by default
      // await newAgent.checkPublicKey();
    } catch (e) {
      const err = new Error('Invalid secret. ' + e);
      setError(err);
    }
  }

  return (
    <Main>
      <ContainerNarrow>
        <h1>User Settings</h1>
        <p>
          An Agent is a user, consisting of a Subject (its URL) and Private Key.
          Together, these can be used to edit data and sign Commits.
        </p>
        {agent ? (
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
          </Column>
        ) : (
          <>
            <p>
              You can create your own Agent by hosting an{' '}
              <AtomicLink href='https://github.com/atomicdata-dev/atomic-data-rust/tree/master/server'>
                atomic-server
              </AtomicLink>
              . Alternatively, you can use an Invite to get a guest Agent on
              someone else{"'s"} Atomic Server.
            </p>
            <Field
              label={agent ? 'Agent Secret' : 'Enter your Agent Secret'}
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
          </>
        )}
      </ContainerNarrow>
    </Main>
  );
};
