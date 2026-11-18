import type { JSX, ReactNode } from 'react';
import {
  server,
  useTitle,
  type Resource,
  type ResourceSaveState,
  type ResourceSyncStatus,
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
  localCopyLabel,
  resourceSyncPresentation,
  serverCopyLabel,
} from './resourceSyncPresentation';
import {
  useResourceCopyContext,
  type ResourceCopyContext,
} from './useResourceCopyContext';

export function ResourceSyncPanel({
  resource,
  status,
  save,
  headingId,
  onClose,
}: {
  resource: Resource;
  status: ResourceSyncStatus;
  save: ResourceSaveState;
  headingId: string;
  onClose: () => void;
}): JSX.Element {
  const [title] = useTitle(resource);
  const context = useResourceCopyContext(resource);
  const presentation = resourceSyncPresentation(status, save);
  const destination = destinationLabel(status.server.url);
  const localConfirmed = status.local.state === 'confirmed';
  const serverConfirmed =
    status.server.state === 'confirmed' && save.kind === 'idle';

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
        >
          {status.local.error && <Note>{status.local.error}</Note>}
        </CopyRow>
        <CopyRow
          icon={<FaServer aria-hidden />}
          name={destination}
          confirmed={serverConfirmed}
          description={serverCopyLabel(status.server, save)}
        >
          {status.server.state !== 'not-configured' && (
            <Note>
              {context.serverConnected
                ? 'Currently connected'
                : 'Currently offline'}
            </Note>
          )}
          {save.error && <Note>{save.error}</Note>}
        </CopyRow>
      </CopyList>

      <Section aria-label='Workspace destinations'>
        <SectionHeading>Workspace destinations</SectionHeading>
        <CopyRow
          icon={<FaVault aria-hidden />}
          name='Cloud Vault'
          description={vaultContextLabel(context.vault)}
        >
          {context.lastBackupAt !== null && (
            <Note>
              Last workspace backup: {formatTime(context.lastBackupAt)}
            </Note>
          )}
          {context.vault !== 'off' && (
            <Note>This resource’s latest backup is not confirmed here.</Note>
          )}
        </CopyRow>
        <CopyRow
          icon={
            <PeerIcon>
              <FaShareNodes aria-hidden />
            </PeerIcon>
          }
          name='Browser peers'
          description={context.peerStatus || 'Connection not confirmed'}
        >
          <Note>
            Workspace connection only. Resource copies are not confirmed.
          </Note>
          <Note>Browser peers may become unavailable when tabs close.</Note>
        </CopyRow>
      </Section>

      {resource.hasClasses(server.classes.file) && (
        <Note>
          These confirmations cover file details. The file’s contents are not
          verified here.
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
  children,
}: {
  icon: ReactNode;
  name: string;
  description: string;
  confirmed?: boolean;
  children?: ReactNode;
}) {
  return (
    <CopyItem>
      <DestinationIcon>{icon}</DestinationIcon>
      <CopyText>
        <Row center justify='space-between' gap='0.5rem'>
          <CopyName>{name}</CopyName>
          {confirmed && (
            <ConfirmedCheck aria-hidden>
              <FaCheck />
            </ConfirmedCheck>
          )}
        </Row>
        <CopyDescription $confirmed={confirmed}>{description}</CopyDescription>
        {children}
      </CopyText>
    </CopyItem>
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

const CopyDescription = styled.div<{ $confirmed: boolean }>`
  font-size: 0.8rem;
  margin-top: 0.2rem;
  color: ${p => (p.$confirmed ? p.theme.colors.success : p.theme.colors.text)};
`;

const ConfirmedCheck = styled.span`
  display: inline-flex;
  color: ${p => p.theme.colors.success};
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

const Section = styled.section`
  border-top: 1px solid ${p => p.theme.colors.bg1};
  padding-top: ${p => p.theme.size()};
`;

const SectionHeading = styled.h3`
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
  font-weight: 500;
  margin: 0;
`;

const Footer = styled(Column)`
  gap: ${p => p.theme.size()};
  font-size: 0.875rem;
  border-top: 1px solid ${p => p.theme.colors.bg1};
  padding-top: ${p => p.theme.size()};
`;
