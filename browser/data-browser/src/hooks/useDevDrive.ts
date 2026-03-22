import { Agent, JSCryptoProvider, core, server, useStore } from '@tomic/react';
import { useCallback, useState } from 'react';
import { useSettings } from '../helpers/AppSettings';
import { saveAgentToIDB } from '../helpers/agentStorage';
import { constructOpenURL } from '../helpers/navigation';
import { useNavigateWithTransition } from './useNavigateWithTransition';

export const DEV_SERVER = 'http://localhost:9883';
export const DEV_DRIVE_TESTID = 'dev-drive-button';

/**
 * Creates a fresh agent and drive on the local dev server (localhost:9883) and
 * switches to it. Only intended for development / E2E-test use.
 */
export function useDevDrive() {
  const store = useStore();
  const { setAgent, setDrive, setServer } = useSettings();
  const navigate = useNavigateWithTransition();
  const [loading, setLoading] = useState(false);

  const createDevDrive = useCallback(async () => {
    setLoading(true);

    try {
      setServer(DEV_SERVER);

      const agentKeys = await Agent.generateKeyPair();
      const agentDID = `did:ad:agent:${agentKeys.publicKey}`;
      const agentProvider = new JSCryptoProvider(agentKeys.privateKey);
      const newAgent = new Agent(agentProvider, agentDID);

      store.setAgent(newAgent);

      const driveResource = await store.newResource({
        isA: server.classes.drive,
        noParent: true,
        propVals: {
          [core.properties.name]: 'dev',
          [core.properties.write]: [agentDID],
          [core.properties.read]: [agentDID],
        },
      });

      await driveResource.save();

      const finalSecret = Agent.buildSecret(
        agentKeys.privateKey,
        agentDID,
        driveResource.subject,
      );

      // Expose for E2E tests so they can sign in as the same agent on other pages.
      localStorage.setItem('atomic-test.dev-drive-secret', finalSecret);

      await saveAgentToIDB(finalSecret);
      setAgent(newAgent);
      setDrive(driveResource.subject);
      navigate(constructOpenURL(driveResource.subject));
    } finally {
      setLoading(false);
    }
  }, [store, setAgent, setDrive, setServer, navigate]);

  return { createDevDrive, loading };
}
