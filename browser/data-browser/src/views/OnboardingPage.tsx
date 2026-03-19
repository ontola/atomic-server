import React, { useState } from 'react';
import { Agent, useStore } from '@tomic/react';
import { saveAgentToIDB } from '../helpers/agentStorage';
import { ContainerNarrow } from '../components/Containers';
import { Column } from '../components/Row';
import { Button } from '../components/Button';
import { InputWrapper } from '../components/forms/InputStyles';
import { styled } from 'styled-components';
import { Main } from '../components/Main';
import { useSettings } from '../helpers/AppSettings';
import { NewIdentitySection } from '../components/NewIdentitySection';

const Card = styled.div`
  background: ${props => props.theme.colors.bg};
  border: 1px solid ${props => props.theme.colors.bg2};
  padding: 2rem;
  border-radius: 1rem;
  box-shadow: 0 0 1rem rgba(0, 0, 0, 0.1);
`;

const INITIAL_DRIVE = 'https://atomicdata.dev/properties/initialDrive';

export const OnboardingPage: React.FC = () => {
  const store = useStore();
  const { baseURL, setAgent } = useSettings();
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);

  async function setupServer(driveDID: string) {
    const resp = await store.postToServer(
      `${baseURL}/setup`,
      JSON.stringify({ [INITIAL_DRIVE]: driveDID }),
    );

    if (resp.error) {
      throw resp.error;
    }
  }

  const handleImport = async () => {
    setLoading(true);

    try {
      const newAgent = await Agent.fromSecret(secret);
      setAgent(newAgent);
      await saveAgentToIDB(secret);

      let driveToMap = newAgent.initialDrive;

      if (!driveToMap) {
        const drives = await store.getResource(
          'https://atomicdata.dev/properties/drives',
        );
        // @ts-ignore
        const driveList = drives.get('https://atomicdata.dev/properties/drives') || [];

        if (driveList.length > 0) {
          driveToMap = driveList[0];
        }
      }

      if (driveToMap) {
        await setupServer(driveToMap);
        window.location.reload();
      }
    } catch (e) {
      store.notifyError(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Main subject={baseURL}>
      <ContainerNarrow>
        <Column gap='2rem'>
          <h1>Welcome to Atomic Data</h1>
          <p>
            This server node is currently uninitialized for{' '}
            <strong>{new URL(baseURL).host}</strong>.
          </p>

          <Card>
            <Column gap='2rem'>
              <NewIdentitySection
                onAfterCreate={setupServer}
                onDone={() => window.location.reload()}
                doneLabel="Yes, I've stored it safely"
              />

              <hr style={{ width: '100%', opacity: 0.1, border: 'none', borderTop: '1px solid' }} />

              <Column gap='1rem'>
                <h3>Use an existing identity</h3>
                <p>
                  Paste your Atomic Data secret key below to connect your
                  existing identity to this node.
                </p>
                <InputWrapper>
                  <textarea
                    value={secret}
                    onChange={e => setSecret(e.target.value)}
                    placeholder='eyJwcml2YXRlS2V5Ijog...'
                    rows={3}
                    style={{
                      width: '100%',
                      fontFamily: 'monospace',
                      padding: '0.5rem',
                      borderRadius: '4px',
                    }}
                  />
                </InputWrapper>
                <Button disabled={!secret || loading} onClick={handleImport}>
                  {loading ? 'Importing...' : 'Import & Connect'}
                </Button>
              </Column>
            </Column>
          </Card>
        </Column>
      </ContainerNarrow>
    </Main>
  );
};
