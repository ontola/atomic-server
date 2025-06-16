import React, { useState } from 'react';
import { useWelcomeLayoutEffect } from '../hooks/useWelcomeLayoutEffect';
import { Agent, useStore } from '@tomic/react';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import { useSettings } from '../helpers/AppSettings';
import { saveAgentToIDB } from '../helpers/agentStorage';
import { constructOpenURL } from '../helpers/navigation';
import { paths } from '../routes/paths';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { useSavedDrives } from '../hooks/useSavedDrives';
import { useDriveHistory } from '../hooks/useDriveHistory';
import { Column } from '../components/Row';
import { AtomicLink } from '../components/AtomicLink';
import { styled } from 'styled-components';
import { LoggedOutAgentPanel } from '../components/LoggedOutAgentPanel';

type Props = {
  /** Canonical subject for the server home (used to refetch after sign-in). */
  subject: string;
};

/**
 * Full-screen entry when the server has nothing useful at `/` (no mapped root
 * drive yet, or the user must sign in). Reuses the same create / sign-in UI as
 * User Settings, with a short intro and navigation after sign-in.
 */
export function RootWelcomeGate({ subject }: Props) {
  useWelcomeLayoutEffect();
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const { setAgent, setDrive, baseURL } = useSettings();
  const [savedDrives] = useSavedDrives();
  const [, addToHistory] = useDriveHistory(savedDrives);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  const host = (() => {
    try {
      return new URL(baseURL).host;
    } catch {
      return baseURL;
    }
  })();

  async function handleSignInWithSecret(secret: string) {
    setLoading(true);
    setError(undefined);

    try {
      const newAgent = await Agent.fromSecret(secret);
      setAgent(newAgent);
      await saveAgentToIDB(secret);

      const home = await fetchPersonalDriveSubject(store, newAgent);

      if (home) {
        setDrive(home);
        addToHistory(home);
        await store.fetchResourceFromServer(subject, { setLoading: true });
        navigate(constructOpenURL(home));
      } else {
        await store.fetchResourceFromServer(subject, { setLoading: true });
        navigate(paths.agentSettings);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Could not parse that secret.'),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell>
      <Inner>
        <Column gap='2rem'>
          <header>
            <h1>Welcome to AtomicServer</h1>
          </header>

          <LoggedOutAgentPanel
            onCreateIdentityClick={() => navigate(paths.onboarding)}
            onSignInWithSecret={handleSignInWithSecret}
            error={error}
            loading={loading}
            fieldId='root-welcome-agent-secret'
          />
        </Column>
      </Inner>
    </Shell>
  );
}

const Shell = styled.div`
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: ${p => p.theme.size(4)};
  box-sizing: border-box;
`;

const Inner = styled.div`
  width: min(100%, ${p => p.theme.containerWidth}rem);
  margin-inline: auto;
`;

const Lead = styled.p`
  margin: ${p => p.theme.size(2)} 0 0;
  line-height: 1.5;
  color: ${p => p.theme.colors.textLight};
`;
