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
import { styled } from 'styled-components';
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

  return (
    <Main>
      <ContainerNarrow>
        <h1>Sync</h1>
        <Lead>
          Inspect the current connection state, background sync activity, and
          websocket details for this client.
        </Lead>

        <Section>
          <h2>Status</h2>
          <Grid>
            <DebugRow>
              <DebugKey>connection</DebugKey>
              <DebugValue>
                {status.serverConnected ? 'connected' : 'offline'}
              </DebugValue>
            </DebugRow>
            <DebugRow>
              <DebugKey>syncing</DebugKey>
              <DebugValue>{status.syncInProgress ? 'yes' : 'no'}</DebugValue>
            </DebugRow>
            <DebugRow>
              <DebugKey>drive sync</DebugKey>
              <DebugValue>
                {status.driveSyncInProgress ? 'running' : 'idle'}
              </DebugValue>
            </DebugRow>
            <DebugRow>
              <DebugKey>dirty sync</DebugKey>
              <DebugValue>
                {status.dirtySyncInProgress ? 'running' : 'idle'}
              </DebugValue>
            </DebugRow>
            <DebugRow>
              <DebugKey>pending dirty</DebugKey>
              <DebugValue>{String(status.pendingDirtyCount)}</DebugValue>
            </DebugRow>
          </Grid>
        </Section>

        <Section>
          <h2>Connection</h2>
          <Grid>
            <DebugRow>
              <DebugKey>server</DebugKey>
              <DebugValue title={status.serverUrl}>{status.serverUrl}</DebugValue>
            </DebugRow>
            <DebugRow>
              <DebugKey>drive</DebugKey>
              <DebugValue title={status.drive}>{status.drive || 'none'}</DebugValue>
            </DebugRow>
            <DebugRow>
              <DebugKey>ws state</DebugKey>
              <DebugValue>
                {formatReadyState(status.websocketReadyState)}
              </DebugValue>
            </DebugRow>
            <DebugRow>
              <DebugKey>ws protocol</DebugKey>
              <DebugValue>{status.websocketProtocol ?? 'unknown'}</DebugValue>
            </DebugRow>
            <DebugRow>
              <DebugKey>client db</DebugKey>
              <DebugValue>
                {status.clientDbReady ? 'ready' : 'not ready'}
              </DebugValue>
            </DebugRow>
          </Grid>
        </Section>

        <Section>
          <h2>Last Drive Sync</h2>
          {status.lastDriveSync ? (
            <Grid>
              <DebugRow>
                <DebugKey>drive</DebugKey>
                <DebugValue title={status.lastDriveSync.drive}>
                  {status.lastDriveSync.drive}
                </DebugValue>
              </DebugRow>
              <DebugRow>
                <DebugKey>resources</DebugKey>
                <DebugValue>{String(status.lastDriveSync.count)}</DebugValue>
              </DebugRow>
              <DebugRow>
                <DebugKey>timestamp</DebugKey>
                <DebugValue>
                  {new Date(status.lastDriveSync.timestamp).toLocaleString()}
                </DebugValue>
              </DebugRow>
            </Grid>
          ) : (
            <Muted>No completed drive sync recorded yet.</Muted>
          )}
        </Section>

        <Section>
          <h2>Commit Log</h2>
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
                        {entry.direction === 'outgoing' ? '↑' : '↓'}{' '}
                        {entry.direction}
                      </Direction>
                      {entry.destroy && <DestroyBadge>destroy</DestroyBadge>}
                    </LogHeaderLeft>
                    {entry.commitId ? (
                      <AtomicLink subject={entry.commitId}>
                        <TimeText title={new Date(entry.timestamp).toLocaleString()}>
                          {formatTimeAgo(new Date(entry.timestamp)) ?? 'just now'}
                        </TimeText>
                      </AtomicLink>
                    ) : (
                      <TimeText title={new Date(entry.timestamp).toLocaleString()}>
                        {formatTimeAgo(new Date(entry.timestamp)) ?? 'just now'}
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
            <Muted>No commits recorded in this session yet.</Muted>
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

function formatReadyState(readyState?: number): string {
  switch (readyState) {
    case WebSocket.CONNECTING:
      return 'connecting';
    case WebSocket.OPEN:
      return 'open';
    case WebSocket.CLOSING:
      return 'closing';
    case WebSocket.CLOSED:
      return 'closed';
    default:
      return 'unavailable';
  }
}

const Lead = styled.p`
  color: ${p => p.theme.colors.textLight};
  margin-bottom: 2rem;
`;

const Section = styled.section`
  margin-bottom: 2rem;
`;

const Grid = styled.div`
  display: grid;
  gap: 0.45rem;
`;

const DebugRow = styled.div`
  display: grid;
  grid-template-columns: 8rem minmax(0, 1fr);
  gap: 0.8rem;
  min-width: 0;
  padding: 0.6rem 0.8rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};
`;

const DebugKey = styled.span`
  color: ${p => p.theme.colors.textLight};
  text-transform: lowercase;
`;

const DebugValue = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'IBM Plex Mono', monospace;
`;

const Muted = styled.p`
  color: ${p => p.theme.colors.textLight};
`;

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
