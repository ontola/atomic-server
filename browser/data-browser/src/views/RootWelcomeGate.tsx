import React, { useState } from 'react';
import { useWelcomeLayoutEffect } from '../hooks/useWelcomeLayoutEffect';
import { useStore } from '@tomic/react';
import { Agent } from '@tomic/lib';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import { useSettings } from '../helpers/AppSettings';
import { saveAgentToIDB } from '../helpers/agentStorage';
import { constructOpenURL } from '../helpers/navigation';
import { paths } from '../routes/paths';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { useSavedDrives } from '../hooks/useSavedDrives';
import { useDriveHistory } from '../hooks/useDriveHistory';
import { css, styled } from 'styled-components';
import { LoggedOutAgentPanel } from '../components/LoggedOutAgentPanel';
import atomicServerLogoUrl from '../../../../logo.svg?url';
import { welcomeBackgroundCss } from './welcomeBackground';

type Props = {
  /** Canonical subject for the server home (used to refetch after sign-in). */
  subject: string;
};

/**
 * Full-screen entry when the server has nothing useful at `/` (no mapped root
 * drive yet, or the user must sign in). Product pitch + sign-in card.
 */
export function RootWelcomeGate({ subject }: Props) {
  useWelcomeLayoutEffect();
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const { setAgent, setDrive } = useSettings();
  const [savedDrives] = useSavedDrives();
  const [, addToHistory] = useDriveHistory(savedDrives);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();

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
        navigate(constructOpenURL(home));
      } else {
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

  const slogans: string[] = [
    'Make your knowledge work for you.',
  ];

  return (
    <Shell>
      <Layout>
        <Pitch>
          <VisuallyHiddenH1>AtomicServer</VisuallyHiddenH1>
          <AtomicServerLogo src={atomicServerLogoUrl} alt='' decoding='async' />
          <h2>{slogans[Math.floor(Math.random() * slogans.length)]}</h2>
          <PropList>
            <li>
              <strong>All-in-one workspace</strong>: documents, tables, files,
              and APIs in one place, designed to stay coherent as it grows.
            </li>
            <li>
              <strong>Fast and lightweight</strong>: a snappy workspace and API,
              small download, minimal dependencies, runs anywhere.
            </li>
            <li>
              <strong>Open source</strong>: inspect, fork, and self-host. Keep
              control of your data and avoid lock-in.
            </li>
            <li>
              <strong>Future of the web</strong>: decentralized by design, built
              for interoperability so your data and tools can work together.
            </li>
            <li>
              <strong>Feature complete by default</strong>: rights, history,
              search, invites, realtime sync, collaboration, and AI chat built
              in.
            </li>
          </PropList>
        </Pitch>
        <CardColumn>
          <LoggedOutAgentPanel
            heading='Get started'
            headingLevel={2}
            onCreateIdentityClick={() => navigate(paths.onboarding)}
            onSignInWithSecret={handleSignInWithSecret}
            error={error}
            loading={loading}
            fieldId='root-welcome-agent-secret'
          />
        </CardColumn>
      </Layout>
    </Shell>
  );
}

const Shell = styled.div`
  min-height: ${p => p.theme.heights.fullPage};
  display: flex;
  align-items: center;
  justify-content: center;
  padding: ${p => p.theme.size(7)} ${p => p.theme.size(5)};
  box-sizing: border-box;
  ${welcomeBackgroundCss}
`;

const Layout = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${p => p.theme.size(8)};
  width: 100%;
  max-width: 64rem;
  margin-inline: auto;

  @media (min-width: 56em) {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: ${p => p.theme.size(10)};
  }
`;

const Pitch = styled.div`
  flex: 1;
  min-width: 0;
  max-width: 34rem;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: start;
  gap: ${p => p.theme.size(5)};

  @media (min-width: 56em) {
    align-items: flex-start;
    text-align: start;
  }
`;

const VisuallyHiddenH1 = styled.h1`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
`;

const AtomicServerLogo = styled.img`
  width: 100%;
  max-width: min(30rem, 92vw);
  height: auto;
  display: block;
  margin-inline: auto;

  @media (min-width: 56em) {
    margin-inline: 0;
  }

  ${p =>
    p.theme.darkMode &&
    css`
      filter: brightness(0) invert(1);
    `}
`;

const PropList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(4)};
  font-size: 0.95rem;
  line-height: 1.5;
  color: ${p => p.theme.colors.text};
  width: 100%;
  max-width: 46rem;

  strong {
    color: ${p => p.theme.colors.text};
    font-weight: 600;
  }

  li {
    margin: 0;
    position: relative;
    list-style: none;
    padding-inline-start: ${p => p.theme.size(5)};
  }

  li::before {
    content: '';
    position: absolute;
    inline-size: 0.45rem;
    block-size: 0.45rem;
    inset-inline-start: ${p => p.theme.size(2)};
    inset-block-start: 0.55em;
    border-radius: 999px;
    background: ${p => p.theme.colors.main};
    opacity: 0.9;
  }
`;

const CardColumn = styled.div`
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  width: 100%;

  @media (min-width: 56em) {
    width: auto;
    align-self: center;
  }
`;
