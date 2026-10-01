import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { useStore } from '@tomic/react';
import { FaCloud, FaRegWindowMaximize } from 'react-icons/fa6';
import { Button } from '../components/Button';
import { ContainerNarrow } from '../components/Containers';
import { Column, Row } from '../components/Row';
import { VaultRestoreAction } from '../components/Vault/VaultRestoreAction';
import { useSettings } from '../helpers/AppSettings';
import { resumePeerLinks } from '../helpers/browserPeerSync';

import type { JSX } from 'react';

/** How often the page asks again on its own. */
export const RETRY_EVERY_MS = 10_000;

/**
 * For a resource this device holds no copy of and nothing can deliver right
 * now: a drive that syncs only between devices while none of them is open, or
 * a drive on a server this device cannot reach. Says which, keeps retrying,
 * and offers the vault when there is a backup. Replaces a bare transport
 * error, which read as a crash.
 */
export function DriveUnavailable({
  subject,
  error,
}: {
  subject: string;
  error: Error;
}): JSX.Element {
  const store = useStore();
  const { agent } = useSettings();
  const localOnly = store.isLocalOnlySubject(subject);
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);

    try {
      // Peer links may have dropped while nothing was open; wake them too.
      resumePeerLinks(store);
      await store.fetchResourceFromServer(subject);
    } finally {
      setRetrying(false);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => {
      resumePeerLinks(store);
      void store.fetchResourceFromServer(subject);
    }, RETRY_EVERY_MS);

    return () => clearInterval(timer);
  }, [store, subject]);

  return (
    <ContainerNarrow>
      <Column gap='1.5rem'>
        <h1>This drive isn't on this device yet</h1>
        <Lead>
          {localOnly
            ? "This drive isn't connected to a server, so it syncs directly between devices. Open it on a device that has it, and it will arrive here."
            : "This device can't reach the drive's server, and it hasn't kept a copy of it. It will open as soon as the server answers."}
        </Lead>
        {/* With a backup, restoring is the way out; offer it first. */}
        {agent && <VaultRestoreAction subject={subject} />}
        <Panel data-testid='drive-unavailable'>
          <Diagram aria-hidden>
            <Node $muted={localOnly}>
              <Circle $dashed={localOnly}>
                <FaCloud />
              </Circle>
              <span>{localOnly ? 'No server' : 'Server'}</span>
            </Node>
            <Line />
            <Devices>
              <Node>
                <Circle $active>
                  <FaRegWindowMaximize />
                </Circle>
                <span>This device</span>
              </Node>
              <Link />
              <Node $muted>
                <Circle>
                  <FaRegWindowMaximize />
                </Circle>
                <span>Your other devices</span>
              </Node>
            </Devices>
          </Diagram>
          <Status role='status'>
            <Dot />
            <p>
              <strong>
                {localOnly
                  ? 'No device with this drive is reachable.'
                  : "The server isn't reachable."}
              </strong>{' '}
              Retrying automatically every 10 seconds.
            </p>
            <Button onClick={retry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry now'}
            </Button>
          </Status>
        </Panel>
        {localOnly && (
          <Hint>
            <FaCloud />
            <p>
              <strong>Sync anytime with a server.</strong> Once the drive's
              owner connects it to a server, it opens on any device, even when
              the others are closed.
            </p>
          </Hint>
        )}
        <Details>
          <summary>Technical details</summary>
          <code>{subject}</code>
          <p>{error.message}</p>
        </Details>
      </Column>
    </ContainerNarrow>
  );
}

const Lead = styled.p`
  color: ${p => p.theme.colors.textLight};
  font-size: 1.1rem;
  margin: 0;
`;

const Panel = styled.section`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg};
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
`;

const Diagram = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
`;

const Devices = styled.div`
  display: flex;
  align-items: center;
  width: 100%;
  justify-content: space-between;
`;

const Node = styled.div<{ $muted?: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  color: ${p => (p.$muted ? p.theme.colors.textLight : p.theme.colors.text)};
  font-weight: 500;
  min-width: 7rem;
  text-align: center;
`;

const Circle = styled.div<{ $active?: boolean; $dashed?: boolean }>`
  width: 4rem;
  height: 4rem;
  border-radius: ${p => (p.$dashed ? p.theme.radius : '50%')};
  display: grid;
  place-items: center;
  font-size: 1.5rem;
  background: ${p =>
    p.$active
      ? p.theme.colors.main
      : p.$dashed
        ? 'transparent'
        : p.theme.colors.bg2};
  color: ${p => (p.$active ? p.theme.colors.bg : p.theme.colors.textLight)};
  border: ${p => (p.$dashed ? `2px dashed ${p.theme.colors.bg2}` : 'none')};
`;

const Line = styled.div`
  height: 1.5rem;
  border-left: 2px dashed ${p => p.theme.colors.bg2};
`;

const Link = styled.div`
  flex: 1;
  margin: 0 1rem 1.75rem;
  border-top: 2px dashed ${p => p.theme.colors.bg2};
`;

const Status = styled(Row)`
  border-top: 1px solid ${p => p.theme.colors.bg2};
  padding-top: 1rem;
  align-items: center;

  p {
    flex: 1;
    margin: 0;
    color: ${p => p.theme.colors.textLight};
  }

  strong {
    color: ${p => p.theme.colors.text};
  }
`;

const Dot = styled.span`
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${p => p.theme.colors.warning};
`;

const Hint = styled.div`
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  padding: 1.25rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};

  svg {
    color: ${p => p.theme.colors.main};
    font-size: 1.25rem;
    flex-shrink: 0;
    margin-top: 0.2rem;
  }

  p {
    margin: 0;
  }
`;

const Details = styled.details`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;

  code {
    display: block;
    word-break: break-all;
    margin-top: 0.5rem;
  }
`;
