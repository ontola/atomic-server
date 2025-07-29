import { Agent, JSCryptoProvider, useStore } from '@tomic/react';
import { useCallback, useState } from 'react';
import { useSettings } from '../helpers/AppSettings';
import { saveAgentToIDB } from '../helpers/agentStorage';
import { constructOpenURL } from '../helpers/navigation';
import { useNavigateWithTransition } from './useNavigateWithTransition';

export const DEV_SERVER = 'http://localhost:9883';
export const DEV_DRIVE_TESTID = 'dev-drive-button';

/** In drive description; server `/prunetests` deletes drives containing this. Keep in sync with `prunetests.rs`. */
export const DEV_DRIVE_PRUNE_MARKER = '[atomic-data:dev-drive]';

const DEV_DRIVE_DISPLAY_NAME = 'Dev drive';

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

      const driveResource = await store.createDrive(
        DEV_DRIVE_DISPLAY_NAME,
        `Created via \`/app/dev-drive\` for local development and E2E. You can remove these with Prune test data on \`/app/prunetests\`. \n\n${DEV_DRIVE_PRUNE_MARKER}`,
      );

      const finalSecret = Agent.buildSecret(
        agentKeys.privateKey,
        agentDID,
        driveResource.subject,
      );

      // Expose for E2E tests so they can sign in as the same agent on other pages.
      localStorage.setItem('atomic-test.dev-drive-secret', finalSecret);

      await saveAgentToIDB(finalSecret);
      const updatedAgent = await Agent.fromSecret(finalSecret);
      store.setAgent(updatedAgent);
      setAgent(updatedAgent);
      setDrive(driveResource.subject);
      navigate(constructOpenURL(driveResource.subject));
    } finally {
      setLoading(false);
    }
  }, [store, setAgent, setDrive, setServer, navigate]);

  return { createDevDrive, loading };
}
