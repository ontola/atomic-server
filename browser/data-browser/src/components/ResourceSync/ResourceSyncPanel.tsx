import type { JSX, ReactNode } from 'react';
import {
  useTitle,
  type Resource,
  type ResourceSaveState,
  type ResourceSyncStatus,
  type ResourcePeerSyncStatus,
} from '@tomic/react';
import {
  FaCheck,
  FaDesktop,
  FaServer,
  FaVault,
  FaShareNodes,
  FaXmark,
} from 'react-icons/fa6';
import { styled } from 'styled-components';
import { setLightness } from 'polished';
import { presetColors } from '../../styling';
import { Row, Column } from '../Row';
import { IconButton } from '../IconButton/IconButton';
import { AtomicLink } from '../AtomicLink';
import { paths } from '../../routes/paths';
import {
  resourceSyncPresentation,
  attachmentCopyLabel,
  completePeerCopyCount,
  peerHasConfirmedContents,
  type AttachmentCopyPresentationStatus,
  type ResourceAttachmentPresentationStatus,
  type ResourceVaultPresentationStatus,
} from './resourceSyncPresentation';
import {
  localCopyLabel,
  serverCopyLabel,
  vaultCopyLabel,
  peerCopyLabel,
} from './resourceCopyLabels';
import {
  useResourceCopyContext,
  type ResourceCopyContext,
} from './useResourceCopyContext';

export function ResourceSyncPanel({
  resource,
  status,
  vault,
  peers,
  contents,
  save,
  headingId,
  onClose,
}: {
  resource: Resource;
  status: ResourceSyncStatus;
  vault: ResourceVaultPresentationStatus;
  peers: ResourcePeerSyncStatus;
  contents: ResourceAttachmentPresentationStatus;
  save: ResourceSaveState;
  headingId: string;
  onClose: () => void;
}): JSX.Element {
  const [title] = useTitle(resource);
  const context = useResourceCopyContext(resource);
  const presentation = resourceSyncPresentation(
    status,
    save,
    vault,
    peers,
    contents,
  );
  const confirmedTime =
    vault.confirmedAt === undefined
      ? null
      : new Date(vault.confirmedAt).toLocaleString();
  const destination = destinationLabel(status.server.url);
  const localConfirmed =
    status.local.state === 'confirmed' &&
    (!contents.required || contents.local.state === 'confirmed');
  const serverConfirmed =
    status.server.state === 'confirmed' &&
    save.kind === 'idle' &&
    (!contents.required || contents.server.state === 'confirmed');
  const completePeers = completePeerCopyCount(peers, contents);

  return (
    <Panel
      data-testid='resource-sync-panel'
      data-resource-sync
      aria-labelledby={headingId}
      onClick={event => event.stopPropagation()}
    >
      <Row center justify='space-between' gap='0.5rem'>
        <Heading id={headingId}>Copies &amp; sync</Heading>
        <CloseButton
          type='button'
          title='Close copies and sync'
          aria-label='Close copies and sync'
          onClick={onClose}
        >
          <FaXmark aria-hidden />
        </CloseButton>
      </Row>
      <Column gap='0.3rem'>
        <ResourceName>{title}</ResourceName>
        <Summary role='status'>{presentation.label}</Summary>
      </Column>

      <CopyList aria-label='Resource copies'>
        <CopyRow
          icon={<FaDesktop aria-hidden />}
          name='This device'
          confirmed={localConfirmed}
          description={localCopyLabel(status.local)}
          hasContents={contents.required}
        >
          {contents.required && (
            <AttachmentStatus status={contents.local} destination='local' />
          )}
          {status.local.error && <Note>{status.local.error}</Note>}
        </CopyRow>
        <CopyRow
          icon={<FaServer aria-hidden />}
          name={destination}
          confirmed={serverConfirmed}
          description={serverCopyLabel(status.server, save)}
          hasContents={contents.required}
        >
          {contents.required && (
            <AttachmentStatus status={contents.server} destination='server' />
          )}
          {status.server.state !== 'not-configured' && (
            <Note>
              {context.serverConnected
                ? 'Currently connected'
                : 'Currently offline'}
            </Note>
          )}
          {save.error && <Note>{save.error}</Note>}
        </CopyRow>
        <CopyRow
          icon={<FaVault aria-hidden />}
          name='Cloud Vault'
          confirmed={
            vault.state === 'confirmed' &&
            (!contents.required || contents.vault.state === 'confirmed')
          }
          description={vaultCopyLabel(vault)}
          hasContents={contents.required}
        >
          {contents.required && (
            <AttachmentStatus status={contents.vault} destination='vault' />
          )}
          {confirmedTime !== null && (
            <Note>Last confirmed backup: {confirmedTime}</Note>
          )}
          <Note>{vaultContextLabel(context.vault)}</Note>
          {context.lastBackupAt !== null && (
            <Note>
              Last workspace backup: {formatTime(context.lastBackupAt)}
            </Note>
          )}
        </CopyRow>
        <CopyRow
          icon={
            <PeerIcon>
              <FaShareNodes aria-hidden />
            </PeerIcon>
          }
          name='Peers'
          description={peerCopyLabel(peers)}
          confirmed={completePeers > 0}
          hasContents={contents.required}
          peer
        >
          <div
            data-testid='resource-peer-copies'
            data-peer-sync-state={peers.state}
            data-confirmed-count={completePeers}
          >
            <Note>Confirmed peer copies: {completePeers}</Note>
            {contents.required && (
              <Note>Resource-details copies: {peers.confirmedCount}</Note>
            )}
            {peers.peers.length > 0 && (
              <PeerList aria-label='Peer resource copies'>
                {peers.peers.map((copy, index) => (
                  <li key={copy.connectionId} data-peer-copy-state={copy.state}>
                    <CopyName>Peer {index + 1}</CopyName>
                    <CopyDescription
                      $confirmed={
                        copy.state === 'confirmed' &&
                        peerHasConfirmedContents(copy, contents)
                      }
                      $peer
                    >
                      {peerCopyLabel(copy)}
                    </CopyDescription>
                    {contents.required && (
                      <AttachmentStatus
                        destination='peer'
                        status={
                          contents.peers.find(
                            content =>
                              content.connectionId === copy.connectionId &&
                              content.storageId === copy.storageId &&
                              content.generation === copy.generation,
                          ) ?? { state: 'unknown' }
                        }
                        peer
                      />
                    )}
                    {copy.confirmedAt !== undefined && (
                      <Note>{peerConfirmedLabel(copy.confirmedAt)}</Note>
                    )}
                  </li>
                ))}
              </PeerList>
            )}
          </div>
          <Note>
            Peers may become unavailable when browser tabs or apps close.
          </Note>
        </CopyRow>
      </CopyList>

      {contents.required && (
        <Note>
          A complete copy needs both resource details and file contents at the
          same destination.
        </Note>
      )}
      <Footer>
        <AtomicLink
          path={`${paths.sync}?${new URLSearchParams({ drive: context.drive })}`}
        >
          Manage sync and backup
        </AtomicLink>
      </Footer>
    </Panel>
  );
}

function CopyRow({
  icon,
  name,
  description,
  confirmed = false,
  peer = false,
  hasContents = false,
  children,
}: {
  icon: ReactNode;
  name: string;
  description: string;
  confirmed?: boolean;
  peer?: boolean;
  hasContents?: boolean;
  children?: ReactNode;
}) {
  return (
    <CopyItem>
      <DestinationIcon>{icon}</DestinationIcon>
      <CopyText>
        <Row center justify='space-between' gap='0.5rem'>
          <CopyName>{name}</CopyName>
          {confirmed && (
            <ConfirmedCheck aria-hidden $peer={peer}>
              <FaCheck />
            </ConfirmedCheck>
          )}
        </Row>
        <CopyDescription $confirmed={confirmed} $peer={peer}>
          {hasContents ? <>Resource details: {description}</> : description}
        </CopyDescription>
        {children}
      </CopyText>
    </CopyItem>
  );
}

function AttachmentStatus({
  status,
  destination,
  peer = false,
}: {
  status: AttachmentCopyPresentationStatus;
  destination: string;
  peer?: boolean;
}) {
  return (
    <CopyDescription
      data-testid={`resource-content-${destination}`}
      data-content-state={status.state}
      $confirmed={status.state === 'confirmed'}
      $peer={peer}
    >
      {attachmentCopyLabel(status)}
    </CopyDescription>
  );
}

function destinationLabel(url?: string): string {
  if (!url) return 'Server';

  try {
    return new URL(url).host;
  } catch {
    return 'Server';
  }
}

function formatTime(timestamp: number): string {
  // Vault metadata uses Unix seconds, unlike browser receipt timestamps.
  return new Date(timestamp * 1000).toLocaleString();
}

function peerConfirmedLabel(timestamp: number): string {
  const time = new Date(timestamp).toLocaleString();

  return `Last confirmed: ${time}`;
}

function vaultContextLabel(state: ResourceCopyContext['vault']): string {
  switch (state) {
    case 'enabled':
      return 'Workspace backup enabled';
    case 'suspended':
      return 'Workspace backup paused';
    case 'off':
      return 'Workspace backup is off';
    case 'loading':
      return 'Checking workspace backup…';
    default:
      return 'Workspace backup status unavailable';
  }
}

const Panel = styled(Column)`
  padding: ${p => p.theme.size(2)};
  gap: ${p => p.theme.size(2)};
  cursor: default;
  overflow-wrap: anywhere;
`;

const Heading = styled.h2`
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
`;

const ResourceName = styled.div`
  font-weight: 600;
`;

const Summary = styled.div`
  font-size: 0.875rem;
`;

const CloseButton = styled(IconButton)`
  flex-shrink: 0;

  @media (pointer: coarse) {
    min-width: 44px;
    min-height: 44px;
  }
`;

const CopyList = styled.div`
  display: flex;
  flex-direction: column;
`;

const CopyItem = styled.div`
  display: flex;
  align-items: flex-start;
  gap: ${p => p.theme.size()};
  padding: ${p => p.theme.size(2)} 0;
  border-bottom: 1px solid ${p => p.theme.colors.bg1};

  &:last-child {
    border-bottom: none;
  }
`;

const DestinationIcon = styled.span`
  display: inline-flex;
  flex-shrink: 0;
  color: ${p => p.theme.colors.textLight};
  padding-top: 0.2rem;
`;

const CopyText = styled.div`
  min-width: 0;
  flex: 1;
`;

const CopyName = styled.span`
  font-size: 0.875rem;
  font-weight: 600;
`;

const CopyDescription = styled.div<{ $confirmed: boolean; $peer?: boolean }>`
  font-size: 0.8rem;
  margin-top: 0.2rem;
  color: ${p =>
    p.$confirmed
      ? p.$peer
        ? setLightness(p.theme.darkMode ? 0.75 : 0.44, presetColors[5])
        : p.theme.colors.success
      : p.theme.colors.text};
`;

const ConfirmedCheck = styled.span<{ $peer?: boolean }>`
  display: inline-flex;
  color: ${p =>
    p.$peer
      ? setLightness(p.theme.darkMode ? 0.75 : 0.44, presetColors[5])
      : p.theme.colors.success};
`;

const PeerIcon = styled.span`
  color: ${p => setLightness(p.theme.darkMode ? 0.75 : 0.44, presetColors[5])};
  display: inline-flex;
`;

const Note = styled.div`
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
  margin-top: 0.3rem;
`;

const PeerList = styled.ul`
  list-style: none;
  padding: 0;
  margin: ${p => p.theme.size()} 0;
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size()};
`;

const Footer = styled(Column)`
  gap: ${p => p.theme.size()};
  font-size: 0.875rem;
  border-top: 1px solid ${p => p.theme.colors.bg1};
  padding-top: ${p => p.theme.size()};
`;
