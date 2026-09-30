import { FaCloud, FaDesktop } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { useStore } from '@tomic/react';
import { ContainerNarrow } from '../components/Containers';
import { Column, Row } from '../components/Row';
import { Button } from '../components/Button';
import { VaultRestoreAction } from '../components/Vault/VaultRestoreAction';

import type { JSX } from 'react';

/**
 * Shown when a drive can't be opened because no copy is on this device and no
 * server is available to fetch it from, instead of a bare transport error.
 */
export function DriveUnavailable({
  subject,
  error,
  signedIn,
}: {
  subject: string;
  error: Error;
  signedIn: boolean;
}): JSX.Element {
  const store = useStore();

  const retry = () =>
    store.fetchResourceFromServer(subject, { setLoading: true });

  return (
    <ContainerNarrow>
      <Column>
        <h1>This drive isn't available right now</h1>
        <p>
          This device doesn't have a copy of this drive, and there is no server
          to load it from. A device that holds the drive needs to be online, or
          the drive needs to be connected to a server.
        </p>
        <Diagram aria-hidden>
          <Node>
            <Circle $active>
              <FaDesktop />
            </Circle>
            This device
          </Node>
          <Link />
          <Node>
            <Circle $dashed>
              <FaCloud />
            </Circle>
            No server
          </Node>
          <Link />
          <Node>
            <Circle>
              <FaDesktop />
            </Circle>
            A device with the drive
          </Node>
        </Diagram>
        {signedIn && <VaultRestoreAction subject={subject} />}
        <Row wrapItems>
          <Button onClick={retry}>Retry</Button>
          <Button
            subtle
            onClick={() =>
              store.fetchResourceFromServer(subject, {
                fromProxy: true,
                setLoading: true,
              })
            }
            title={`Fetches the drive through your current server (${store.getServerUrl()}), if it has a cached copy.`}
          >
            Use proxy
          </Button>
        </Row>
        <details>
          <summary>Technical details</summary>
          <Technical>{error.message}</Technical>
          <Technical>{subject}</Technical>
        </details>
      </Column>
    </ContainerNarrow>
  );
}

const Diagram = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: ${p => p.theme.size(2)};
  padding: ${p => p.theme.size(4)};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg};
`;

const Node = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${p => p.theme.size(2)};
  text-align: center;
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
  max-width: 8rem;
`;

const Circle = styled.div<{ $active?: boolean; $dashed?: boolean }>`
  display: grid;
  place-items: center;
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 50%;
  font-size: 1.4rem;
  color: ${p => (p.$active ? p.theme.colors.bg : p.theme.colors.textLight)};
  background: ${p => (p.$active ? p.theme.colors.main : p.theme.colors.bg1)};
  border: ${p => (p.$dashed ? `2px dashed ${p.theme.colors.bg2}` : 'none')};
`;

const Link = styled.div`
  flex: 1;
  margin-top: 1.75rem;
  border-top: 2px dashed ${p => p.theme.colors.bg2};
`;

const Technical = styled.pre`
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;
