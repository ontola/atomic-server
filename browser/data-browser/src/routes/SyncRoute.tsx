import { useEffect, useState } from 'react';
import { createRoute } from '@tanstack/react-router';
import {
  StoreEvents,
  type StoreSyncStatus,
  type CommitLogEntry,
  useStore,
  useProperty,
  truncateUrl,
} from '@tomic/react';
import { styled, keyframes, css } from 'styled-components';
import {
  FaLaptop,
  FaServer,
  FaCheck,
  FaArrowsRotate,
  FaQuestion,
  FaCircleExclamation,
} from 'react-icons/fa6';
import { ContainerNarrow } from '../components/Containers';
import { Main } from '../components/Main';
import { Card } from '../components/Card';
import { ResourceInline } from '../views/ResourceInline';
import { AtomicLink } from '../components/AtomicLink';
import { formatTimeAgo } from '../helpers/formatTimeAgo';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';

export const SyncRoute = createRoute({
  path: pathNames.sync,
  component: () => <SyncPage />,
  getParentRoute: () => appRoute,
});

type NodeStatus = 'synced' | 'syncing' | 'unsynced' | 'offline' | 'unknown';

function deriveNodeStatuses(status: StoreSyncStatus): {
  local: NodeStatus;
  server: NodeStatus;
  line: NodeStatus;
} {
  const local: NodeStatus = status.clientDbReady ? 'synced' : 'unknown';

  if (!status.serverConnected) {
    return {
      local,
      server: 'offline',
      line: 'offline',
    };
  }

  if (status.syncInProgress) {
    return { local, server: 'syncing', line: 'syncing' };
  }

  if (status.pendingDirtyCount > 0) {
    return { local, server: 'unsynced', line: 'unsynced' };
  }

  // Only claim "synced" if we've actually completed a drive sync.
  // Otherwise we're connected but haven't confirmed the data matches.
  if (!status.lastDriveSync) {
    return { local, server: 'unknown', line: 'unknown' };
  }

  return { local, server: 'synced', line: 'synced' };
}

function StatusIcon({ status }: { status: NodeStatus }) {
  switch (status) {
    case 'synced':
      return <FaCheck />;
    case 'syncing':
      return <FaArrowsRotate />;
    case 'unsynced':
      return <FaCircleExclamation />;
    case 'offline':
      return <FaQuestion />;
    case 'unknown':
      return <FaQuestion />;
  }
}

function statusLabel(status: NodeStatus): string {
  switch (status) {
    case 'synced':
      return 'In sync';
    case 'syncing':
      return 'Syncing...';
    case 'unsynced':
      return 'Changes pending';
    case 'offline':
      return 'Offline';
    case 'unknown':
      return 'Unknown';
  }
}

function SyncPage() {
  const store = useStore();
  const [status, setStatus] = useState<StoreSyncStatus>(() =>
    store.getSyncStatus(),
  );
  const [commitLog, setCommitLog] = useState<CommitLogEntry[]>(() =>
    store.getCommitLog(),
  );

  useEffect(() => {
    const refresh = () => setStatus(store.getSyncStatus());
    const unsubConnection = store.on(StoreEvents.ConnectionChanged, refresh);
    const unsubSync = store.on(StoreEvents.SyncStatusChanged, next =>
      setStatus(next),
    );
    const unsubCommitLog = store.on(StoreEvents.CommitLogChanged, next =>
      setCommitLog(next),
    );
    const unsubDrive = store.on(StoreEvents.DriveChanged, refresh);
    const unsubServer = store.on(StoreEvents.ServerURLChanged, refresh);

    return () => {
      unsubConnection();
      unsubSync();
      unsubCommitLog();
      unsubDrive();
      unsubServer();
    };
  }, [store]);

  const nodes = deriveNodeStatuses(status);

  return (
    <Main>
      <ContainerNarrow>
        <h1>Sync</h1>
        <Lead>
          Your data is stored locally on this device. When connected to a
          server, changes sync automatically.
        </Lead>

        {/* Visual sync diagram */}
        <SyncDiagram>
          <SyncNode $status={nodes.local}>
            <NodeIcon $status={nodes.local}>
              <FaLaptop />
            </NodeIcon>
            <NodeLabel>This device</NodeLabel>
            <NodeStatusBadge $status={nodes.local}>
              <StatusIcon status={nodes.local} />
              {statusLabel(nodes.local)}
            </NodeStatusBadge>
          </SyncNode>

          <SyncLine $status={nodes.line}>
            <LineTrack />
            {nodes.line === 'syncing' && <LinePulse />}
            {status.pendingDirtyCount > 0 && (
              <PendingBadge>{status.pendingDirtyCount} pending</PendingBadge>
            )}
          </SyncLine>

          <SyncNode $status={nodes.server}>
            <NodeIcon $status={nodes.server}>
              <FaServer />
            </NodeIcon>
            <NodeLabel>
              {status.serverUrl
                ? new URL(status.serverUrl).hostname
                : 'Server'}
            </NodeLabel>
            <NodeStatusBadge $status={nodes.server}>
              <StatusIcon status={nodes.server} />
              {statusLabel(nodes.server)}
            </NodeStatusBadge>
          </SyncNode>
        </SyncDiagram>

        {/* Details accordion */}
        <Section>
          <SectionTitle>Details</SectionTitle>
          <DetailsGrid>
            <DetailItem>
              <DetailLabel>Drive</DetailLabel>
              <DetailValue title={status.drive}>
                {status.drive ? (
                  <ResourceInline subject={status.drive} />
                ) : (
                  'none'
                )}
              </DetailValue>
            </DetailItem>
            <DetailItem>
              <DetailLabel>Server</DetailLabel>
              <DetailValue>{status.serverUrl || 'not set'}</DetailValue>
            </DetailItem>
            <DetailItem>
              <DetailLabel>Connection</DetailLabel>
              <DetailValue>
                {status.serverConnected ? 'Connected' : 'Offline'}
                {status.websocketProtocol
                  ? ` (${status.websocketProtocol})`
                  : ''}
              </DetailValue>
            </DetailItem>
            <DetailItem>
              <DetailLabel>Local storage</DetailLabel>
              <DetailValue>
                {status.clientDbReady ? 'Ready' : 'Initializing...'}
              </DetailValue>
            </DetailItem>
            {status.lastDriveSync && (
              <DetailItem>
                <DetailLabel>Last sync</DetailLabel>
                <DetailValue>
                  {status.lastDriveSync.count} resources,{' '}
                  {formatTimeAgo(
                    new Date(status.lastDriveSync.timestamp),
                  ) ?? 'just now'}
                </DetailValue>
              </DetailItem>
            )}
          </DetailsGrid>
        </Section>

        {/* Activity log */}
        <Section>
          <SectionTitle>Activity</SectionTitle>
          {commitLog.length > 0 ? (
            <LogList>
              {commitLog.map(entry => (
                <CommitCard
                  key={entry.id}
                  highlight={entry.status === 'failed'}
                >
                  <LogHeader>
                    <LogHeaderLeft>
                      <StatusBadge $status={entry.status}>
                        {entry.status}
                      </StatusBadge>
                      <Direction>
                        {entry.direction === 'outgoing' ? '\u2191' : '\u2193'}{' '}
                        {entry.direction}
                      </Direction>
                      {entry.destroy && <DestroyBadge>destroy</DestroyBadge>}
                    </LogHeaderLeft>
                    {entry.commitId ? (
                      <AtomicLink subject={entry.commitId}>
                        <TimeText
                          title={new Date(
                            entry.timestamp,
                          ).toLocaleString()}
                        >
                          {formatTimeAgo(new Date(entry.timestamp)) ??
                            'just now'}
                        </TimeText>
                      </AtomicLink>
                    ) : (
                      <TimeText
                        title={new Date(entry.timestamp).toLocaleString()}
                      >
                        {formatTimeAgo(new Date(entry.timestamp)) ??
                          'just now'}
                      </TimeText>
                    )}
                  </LogHeader>

                  <LogSubjectRow>
                    <LogSubject>
                      <ResourceInline subject={entry.subject} />
                    </LogSubject>
                    <LogSummaryText>{entry.summary}</LogSummaryText>
                  </LogSubjectRow>

                  {entry.propertySummaries &&
                    entry.propertySummaries.length > 0 && (
                      <PropertyList>
                        {entry.propertySummaries.map(ps => (
                          <PropertyRow key={ps.property}>
                            <PropertyName propertyURL={ps.property} />
                            <PropertyValue>
                              {formatValue(ps.value)}
                            </PropertyValue>
                          </PropertyRow>
                        ))}
                      </PropertyList>
                    )}

                  {entry.error && <ErrorText>{entry.error}</ErrorText>}
                </CommitCard>
              ))}
            </LogList>
          ) : (
            <Muted>No activity recorded in this session yet.</Muted>
          )}
        </Section>
      </ContainerNarrow>
    </Main>
  );
}

function PropertyName({ propertyURL }: { propertyURL: string }) {
  const property = useProperty(propertyURL);
  const label = property.loading
    ? 'loading...'
    : property.error
      ? truncateUrl(propertyURL, 10, true)
      : property.shortname;

  return (
    <AtomicLink subject={propertyURL}>
      <PropLabel>{label}</PropLabel>
    </AtomicLink>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 200 ? value.slice(0, 200) + '...' : value;
  }

  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }

  return JSON.stringify(value);
}

// --- Styled components ---

const Lead = styled.p`
  color: ${p => p.theme.colors.textLight};
  margin-bottom: 2rem;
`;

const Section = styled.section`
  margin-bottom: 2rem;
`;

const SectionTitle = styled.h2`
  font-size: 1.1rem;
  margin-bottom: 0.8rem;
`;

const Muted = styled.p`
  color: ${p => p.theme.colors.textLight};
`;

// --- Sync diagram ---

const statusColor = (status: NodeStatus, theme: { colors: Record<string, string> }) => {
  switch (status) {
    case 'synced':
      return theme.colors.main;
    case 'syncing':
      return theme.colors.main;
    case 'unsynced':
      return theme.colors.warning;
    case 'offline':
      return theme.colors.textLight;
    case 'unknown':
      return theme.colors.textLight;
  }
};

const SyncDiagram = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 2rem 1rem;
  margin-bottom: 2rem;
`;

const SyncNode = styled.div<{ $status: NodeStatus }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  min-width: 7rem;
`;

const NodeIcon = styled.div<{ $status: NodeStatus }>`
  font-size: 2.2rem;
  color: ${p => statusColor(p.$status, p.theme)};
  transition: color 0.3s ease;
`;

const NodeLabel = styled.span`
  font-weight: 600;
  font-size: 0.95rem;
`;

const NodeStatusBadge = styled.span<{ $status: NodeStatus }>`
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  color: ${p => statusColor(p.$status, p.theme)};
  padding: 0.2rem 0.6rem;
  border-radius: 1rem;
  background: ${p => statusColor(p.$status, p.theme)}18;

  svg {
    font-size: 0.7rem;
    ${p =>
      p.$status === 'syncing' &&
      css`
        animation: ${spin} 1s linear infinite;
      `}
  }
`;

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const SyncLine = styled.div<{ $status: NodeStatus }>`
  flex: 1;
  position: relative;
  height: 2px;
  min-width: 3rem;
  max-width: 10rem;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const LineTrack = styled.div`
  position: absolute;
  inset: 0;
  background: ${p => p.theme.colors.bg2};
  border-radius: 1px;
`;

const pulseAnim = keyframes`
  0% { left: -30%; }
  100% { left: 100%; }
`;

const LinePulse = styled.div`
  position: absolute;
  top: 0;
  height: 100%;
  width: 30%;
  background: ${p => p.theme.colors.main};
  border-radius: 1px;
  animation: ${pulseAnim} 1.2s ease-in-out infinite;
`;

const PendingBadge = styled.span`
  position: absolute;
  top: -1.4rem;
  font-size: 0.75rem;
  color: ${p => p.theme.colors.warning};
  white-space: nowrap;
  font-weight: 600;
`;

// --- Details ---

const DetailsGrid = styled.div`
  display: grid;
  gap: 0.4rem;
`;

const DetailItem = styled.div`
  display: grid;
  grid-template-columns: 8rem minmax(0, 1fr);
  gap: 0.8rem;
  padding: 0.5rem 0.8rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};
  min-width: 0;
`;

const DetailLabel = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
`;

const DetailValue = styled.span`
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
`;

// --- Activity log ---

const LogList = styled.div`
  display: grid;
  gap: 0.6rem;
`;

const CommitCard = styled(Card)`
  display: grid;
  gap: 0.5rem;
  overflow: hidden;
  min-width: 0;
`;

const LogHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
`;

const LogHeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const StatusBadge = styled.span<{ $status: CommitLogEntry['status'] }>`
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0.15rem 0.4rem;
  border-radius: ${p => p.theme.radius};
  background: ${p =>
    p.$status === 'failed'
      ? p.theme.colors.warning + '22'
      : p.$status === 'sent'
        ? p.theme.colors.main + '22'
        : p.theme.colors.bg2};
  color: ${p =>
    p.$status === 'failed'
      ? p.theme.colors.warning
      : p.$status === 'sent'
        ? p.theme.colors.main
        : p.theme.colors.textLight};
`;

const Direction = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
`;

const TimeText = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-family: 'IBM Plex Mono', monospace;
  font-size: 0.8rem;
`;

const LogSubjectRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
`;

const LogSubject = styled.div`
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
`;

const LogSummaryText = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
  white-space: nowrap;
  flex-shrink: 0;
`;

const PropertyList = styled.div`
  display: grid;
  gap: 0.3rem;
  padding: 0.5rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};
`;

const PropertyRow = styled.div`
  display: grid;
  grid-template-columns: minmax(6rem, auto) minmax(0, 1fr);
  gap: 0.6rem;
  align-items: baseline;
`;

const PropLabel = styled.span`
  font-weight: 600;
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
`;

const PropertyValue = styled.span`
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
`;

const DestroyBadge = styled.span`
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0.15rem 0.4rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.warning}22;
  color: ${p => p.theme.colors.warning};
`;

const ErrorText = styled.div`
  color: ${p => p.theme.colors.warning};
  white-space: pre-wrap;
  font-size: 0.9rem;
`;
