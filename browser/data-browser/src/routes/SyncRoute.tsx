import { forwardRef, useEffect, useMemo, useState } from 'react';
import { createRoute } from '@tanstack/react-router';
import toast from 'react-hot-toast';
import {
  StoreEvents,
  type StoreSyncStatus,
  type CommitLogEntry,
  useStore,
  useProperty,
  useResource,
  useTitle,
  truncateUrl,
  Datatype,
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
import { Button } from '../components/Button';
import { Row } from '../components/Row';
import { ContainerNarrow } from '../components/Containers';
import { Main } from '../components/Main';
import { Card } from '../components/Card';
import { ResourceInline } from '../views/ResourceInline';
import { AtomicLink } from '../components/AtomicLink';
import { formatTimeAgo } from '../helpers/formatTimeAgo';
import { isRunningInTauri } from '../helpers/tauri';
import { isClientDbEnabled, setClientDbEnabled } from '../helpers/clientDbMode';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';
import { useSettings } from '../helpers/AppSettings';
import { serverURLStorage } from '../helpers/serverURLStorage';
import { DriveSwitcher } from '../components/SideBar/DriveSwitcher';
import type {
  DropdownTriggerComponent,
  DropdownTriggerProps,
} from '../components/Dropdown/DropdownTrigger';

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
  const local: NodeStatus = 'synced';

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
  const [wsDebug, setWsDebug] = useState(
    () => localStorage.getItem('ws-debug') === '1',
  );
  const [clientDbOn, setClientDbOn] = useState(() => isClientDbEnabled());
  const { setServer, baseURL } = useSettings();
  const knownServers = serverURLStorage.getKnownServers();
  const [serverInput, setServerInput] = useState('');
  const [showAddServer, setShowAddServer] = useState(false);
  const [irohNodeId, setIrohNodeId] = useState<string | null>(null);
  const [peerInput, setPeerInput] = useState('');
  const [peerSyncing, setPeerSyncing] = useState(false);
  const [peerSyncResult, setPeerSyncResult] = useState<string | null>(null);
  const [showAddPeer, setShowAddPeer] = useState(false);
  const [knownPeers, setKnownPeers] = useState<
    { nodeId: string; label: string; lastSync?: string }[]
  >(() => {
    try {
      return JSON.parse(localStorage.getItem('atomic-peers') ?? '[]');
    } catch {
      return [];
    }
  });

  useEffect(() => {
    fetch('/iroh-node-id')
      .then(r => r.json())
      .then(data => {
        if (data.nodeId) {
          // Strip iroh: prefix if present, store raw hex
          const raw = data.nodeId.startsWith('iroh:')
            ? data.nodeId.slice(5)
            : data.nodeId;
          setIrohNodeId(raw);
        }
      })
      .catch(() => {});
  }, []);

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

  function savePeers(
    peers: { nodeId: string; label: string; lastSync?: string }[],
  ) {
    setKnownPeers(peers);
    localStorage.setItem('atomic-peers', JSON.stringify(peers));
  }

  async function syncWithPeer(nodeId: string) {
    if (!nodeId || !status.drive) return;

    setPeerSyncing(true);
    setPeerSyncResult(null);

    try {
      const res = await fetch('/iroh-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId, drive: status.drive }),
      });
      const data = await res.json();

      if (data.error) {
        setPeerSyncResult(`Error: ${data.error}`);
      } else {
        const msg = `Synced ${data.count} resource${data.count !== 1 ? 's' : ''}`;
        setPeerSyncResult(msg);

        // Save/update peer — strip any prefix to get raw hex
        let cleaned = nodeId;
        if (cleaned.startsWith('did:ad:node:'))
          cleaned = cleaned.slice('did:ad:node:'.length);
        else if (cleaned.startsWith('iroh:')) cleaned = cleaned.slice(5);
        const existing = knownPeers.findIndex(p => p.nodeId === cleaned);
        const entry = {
          nodeId: cleaned,
          label: `did:ad:node:${cleaned.slice(0, 8)}...`,
          lastSync: new Date().toISOString(),
        };

        if (existing >= 0) {
          const updated = [...knownPeers];
          updated[existing] = entry;
          savePeers(updated);
        } else {
          savePeers([...knownPeers, entry]);
        }

        setPeerInput('');
        setShowAddPeer(false);
      }
    } catch (e) {
      setPeerSyncResult(`Error: ${e}`);
    }

    setPeerSyncing(false);
  }

  function removePeer(nodeId: string) {
    savePeers(knownPeers.filter(p => p.nodeId !== nodeId));
  }

  return (
    <Main>
      <ContainerNarrow>
        <h1>Sync</h1>
        <Lead>
          {isRunningInTauri()
            ? 'Your data lives on this device. Add peers or a remote server to sync.'
            : 'Your data is stored locally on this device. When connected to a server, changes sync automatically.'}
        </Lead>

        {isRunningInTauri() ? (
          <LocalDevice>
            <NodeIcon $status="synced">
              <FaLaptop />
            </NodeIcon>
            <LocalDeviceBody>
              <NodeLabel>This device</NodeLabel>
              <Muted style={{ margin: 0, fontSize: '0.85rem' }}>
                {status.lastDriveSync
                  ? `${status.lastDriveSync.count} resources stored locally`
                  : 'Local storage ready'}
              </Muted>
            </LocalDeviceBody>
          </LocalDevice>
        ) : (
          /* Visual sync diagram (client-server) */
          <SyncDiagram>
            <SyncNode $status="synced">
              <NodeIcon $status="synced">
                <FaLaptop />
              </NodeIcon>
              <NodeLabel>This device</NodeLabel>
            </SyncNode>

            <SyncLine $status={nodes.line}>
              <LineTrack $offline={nodes.line === 'offline'} />
              {nodes.line === 'syncing' && <LinePulse />}
              {(nodes.line === 'synced' || nodes.line === 'unsynced') && (
                <HeartbeatDot $status={nodes.line} />
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
              {!status.serverConnected && status.serverConnectionError && (
                <NodeError role="alert">
                  <FaCircleExclamation aria-hidden />
                  <span>{status.serverConnectionError}</span>
                </NodeError>
              )}
              {status.serverConnected ? (
                <NodeAction onClick={() => store.disconnect()}>
                  Disconnect
                </NodeAction>
              ) : (
                <NodeAction
                  onClick={() => {
                    // Failures surface through the global
                    // `StoreEvents.Error` toast (see
                    // `data-browser/src/handlers/errorHandler.ts`).
                    store.reconnect().catch(e => store.notifyError(e));
                  }}
                >
                  Reconnect
                </NodeAction>
              )}
            </SyncNode>
          </SyncDiagram>
        )}

        {/* Details accordion */}
        <Section>
          <SectionTitle>Details</SectionTitle>
          <DetailsGrid>
            <DetailItem>
              <DetailLabel>Drive</DetailLabel>
              <DetailValue title={status.drive}>
                {status.drive ? (
                  <DriveDetailSwitcher drive={status.drive} />
                ) : (
                  'none'
                )}
              </DetailValue>
            </DetailItem>
            <DetailItem>
              <DetailLabel>
                {isRunningInTauri() ? 'Remote server' : 'Server'}
              </DetailLabel>
              <DetailValue>
                <ServerSelect
                  value={baseURL ?? ''}
                  onChange={e => setServer(e.target.value)}
                >
                  {knownServers.map(s => (
                    <option key={s} value={s}>
                      {s.startsWith('iroh:')
                        ? `iroh:${s.slice(5, 13)}...`
                        : isRunningInTauri() &&
                            new URL(s).hostname === 'localhost'
                          ? 'Embedded (local)'
                          : new URL(s).hostname}
                    </option>
                  ))}
                </ServerSelect>
                {!showAddServer && (
                  <NodeAction onClick={() => setShowAddServer(true)}>
                    + Add
                  </NodeAction>
                )}
              </DetailValue>
            </DetailItem>
            {showAddServer && (
              <DetailItem>
                <DetailLabel />
                <DetailValue>
                  <AddServerRow
                    onSubmit={e => {
                      e.preventDefault();

                      if (serverInput.trim()) {
                        setServer(serverInput.trim());
                        setServerInput('');
                        setShowAddServer(false);
                      }
                    }}
                  >
                    <ServerInput
                      autoFocus
                      placeholder="https://... or iroh:..."
                      value={serverInput}
                      onChange={e => setServerInput(e.target.value)}
                    />
                    <Button type="submit" subtle>
                      Add
                    </Button>
                  </AddServerRow>
                  <DocsLink
                    href="https://docs.atomicdata.dev/atomicserver/installation.html"
                    target="_blank"
                    rel="noopener"
                  >
                    How to run your own server
                  </DocsLink>
                </DetailValue>
              </DetailItem>
            )}
            {irohNodeId && (
              <DetailItem>
                <DetailLabel>Node DID</DetailLabel>
                <DetailValue>
                  <PeerIdRow>
                    <PeerIdText title={`did:ad:node:${irohNodeId}`}>
                      did:ad:node:{irohNodeId.slice(0, 12)}...
                    </PeerIdText>
                    <NodeAction
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            `did:ad:node:${irohNodeId}`,
                          );
                          toast.success('Node DID copied to clipboard');
                        } catch (e) {
                          store.notifyError(e as Error);
                        }
                      }}
                    >
                      Copy
                    </NodeAction>
                  </PeerIdRow>
                </DetailValue>
              </DetailItem>
            )}
            <DetailItem>
              <DetailLabel>Peers</DetailLabel>
              <DetailValue>
                {knownPeers.length === 0 && !showAddPeer && (
                  <Muted style={{ margin: 0, fontSize: '0.85rem' }}>
                    No peers connected
                  </Muted>
                )}
                {knownPeers.map(peer => (
                  <PeerRow key={peer.nodeId}>
                    <PeerIdText title={peer.nodeId}>{peer.label}</PeerIdText>
                    {peer.lastSync && (
                      <PeerLastSync>
                        {formatTimeAgo(new Date(peer.lastSync)) ?? 'just now'}
                      </PeerLastSync>
                    )}
                    <NodeAction
                      onClick={() => syncWithPeer(peer.nodeId)}
                      disabled={peerSyncing}
                    >
                      {peerSyncing ? '...' : 'Sync'}
                    </NodeAction>
                    <NodeAction onClick={() => removePeer(peer.nodeId)}>
                      &times;
                    </NodeAction>
                  </PeerRow>
                ))}
                {showAddPeer ? (
                  <AddServerRow
                    onSubmit={e => {
                      e.preventDefault();
                      syncWithPeer(peerInput.trim());
                    }}
                  >
                    <ServerInput
                      autoFocus
                      placeholder="Paste did:ad:node:..."
                      value={peerInput}
                      onChange={e => setPeerInput(e.target.value)}
                      disabled={peerSyncing}
                    />
                    <Button
                      type="submit"
                      subtle
                      disabled={peerSyncing || !peerInput.trim()}
                    >
                      {peerSyncing ? 'Syncing...' : 'Sync'}
                    </Button>
                  </AddServerRow>
                ) : (
                  <NodeAction onClick={() => setShowAddPeer(true)}>
                    + Add
                  </NodeAction>
                )}
                {peerSyncResult && (
                  <PeerSyncResult $error={peerSyncResult.startsWith('Error')}>
                    {peerSyncResult}
                  </PeerSyncResult>
                )}
              </DetailValue>
            </DetailItem>
            {!isRunningInTauri() && (
              <DetailItem>
                <DetailLabel>Local DB</DetailLabel>
                <DetailValue>
                  <LocalDbControl
                    enabled={clientDbOn}
                    attached={status.clientDbAttached}
                    ready={status.clientDbReady}
                    error={status.clientDbError}
                    onToggle={next => {
                      setClientDbEnabled(next);
                      setClientDbOn(next);
                    }}
                  />
                </DetailValue>
              </DetailItem>
            )}
            {status.lastDriveSync && (
              <DetailItem>
                <DetailLabel>Last sync</DetailLabel>
                <DetailValue>
                  {status.lastDriveSync.count} resources,{' '}
                  {formatTimeAgo(new Date(status.lastDriveSync.timestamp)) ??
                    'just now'}
                </DetailValue>
              </DetailItem>
            )}
            <DetailItem>
              <DetailLabel>WS debug</DetailLabel>
              <DetailValue>
                <DebugToggle
                  type="checkbox"
                  checked={wsDebug}
                  onChange={e => {
                    setWsDebug(e.target.checked);
                    store.setWebSocketDebug(e.target.checked);
                  }}
                />
                {wsDebug ? 'Logging to console' : 'Off'}
              </DetailValue>
            </DetailItem>
          </DetailsGrid>
        </Section>

        {/* Commit log */}
        <Section>
          <SectionTitle>
            Commit Log
            {status.pendingDirtyCount > 0 && (
              <PendingCount>{status.pendingDirtyCount} unsynced</PendingCount>
            )}
          </SectionTitle>
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
                          title={new Date(entry.timestamp).toLocaleString()}
                        >
                          {formatTimeAgo(new Date(entry.timestamp)) ??
                            'just now'}
                        </TimeText>
                      </AtomicLink>
                    ) : (
                      <TimeText
                        title={new Date(entry.timestamp).toLocaleString()}
                      >
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
                          <PropertyRow
                            key={ps.property}
                            data-change-type={ps.changeType}
                          >
                            <span aria-hidden="true">
                              {ps.changeType === 'changed' ? '+' : '−'}
                            </span>
                            <PropertyName propertyURL={ps.property} />
                            <PropertyValueDisplay
                              propertyURL={ps.property}
                              value={ps.value}
                            />
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

type LocalDbStatus = 'disabled' | 'initializing' | 'ready' | 'error';

function localDbStatus(args: {
  enabled: boolean;
  attached: boolean;
  ready: boolean;
  error?: string;
}): LocalDbStatus {
  if (!args.enabled) return 'disabled';
  if (args.error) return 'error';
  if (!args.attached || !args.ready) return 'initializing';
  return 'ready';
}

function LocalDbControl({
  enabled,
  attached,
  ready,
  error,
  onToggle,
}: {
  enabled: boolean;
  attached: boolean;
  ready: boolean;
  error?: string;
  onToggle: (next: boolean) => void;
}) {
  const state = localDbStatus({ enabled, attached, ready, error });
  const label: Record<LocalDbStatus, string> = {
    disabled: 'Disabled (server-only)',
    initializing: 'Initializing...',
    ready: 'Ready — WASM + OPFS',
    error: 'Error',
  };
  const noteIfToggled = enabled !== attached ? ' (reload to apply)' : '';
  return (
    <LocalDbStack>
      <LocalDbRow>
        <DebugToggle
          type="checkbox"
          checked={enabled}
          onChange={e => onToggle(e.target.checked)}
          aria-label="Enable local WASM DB"
        />
        <StatusDot $state={state} aria-hidden />
        <LocalDbLabel>
          {label[state]}
          {noteIfToggled}
        </LocalDbLabel>
      </LocalDbRow>
      {state === 'error' && error && <LocalDbError>{error}</LocalDbError>}
    </LocalDbStack>
  );
}

function DriveDetailSwitcher({ drive }: { drive: string }) {
  const driveResource = useResource(drive);
  const [title] = useTitle(driveResource);
  const label = driveResource.isUnauthorized()
    ? 'Unauthorized'
    : (title ?? truncateUrl(drive, 24, true));

  const Trigger = useMemo<DropdownTriggerComponent>(() => {
    const DriveDetailTrigger: DropdownTriggerComponent = forwardRef<
      HTMLButtonElement,
      Omit<DropdownTriggerProps, 'ref'>
    >(({ onClick, menuId, isActive, id }, ref) => (
      <DriveSwitchTriggerButton
        id={id}
        aria-controls={menuId}
        aria-expanded={isActive}
        aria-haspopup="menu"
        onClick={onClick}
        ref={ref}
        title="Open Drive Settings"
        type="button"
      >
        {label}
      </DriveSwitchTriggerButton>
    ));

    DriveDetailTrigger.displayName = 'DriveDetailTrigger';

    return DriveDetailTrigger;
  }, [label]);

  return <DriveSwitcher Trigger={Trigger} />;
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

/**
 * Renders a commit-log property value with type-aware formatting:
 *   - ResourceArray  → comma-separated <ResourceInline> links
 *   - AtomicURL      → single <ResourceInline>
 *   - everything else → text via {@link formatValue}
 *
 * Falls back to text rendering while the property's datatype is still
 * loading or errors out, so a slow / missing property metadata fetch
 * doesn't blank the row.
 */
function PropertyValueDisplay({
  propertyURL,
  value,
}: {
  propertyURL: string;
  value: unknown;
}) {
  const property = useProperty(propertyURL);

  if (value === null) {
    return <PropertyValue>{formatValue(value)}</PropertyValue>;
  }

  if (
    !property.loading &&
    !property.error &&
    property.datatype === Datatype.RESOURCEARRAY &&
    Array.isArray(value)
  ) {
    return (
      <PropertyValue>
        {value.map((subject, i) => (
          <span key={`${i}-${String(subject)}`}>
            {i > 0 && ', '}
            {typeof subject === 'string' ? (
              <ResourceInline subject={subject} />
            ) : (
              String(subject)
            )}
          </span>
        ))}
      </PropertyValue>
    );
  }

  if (
    !property.loading &&
    !property.error &&
    property.datatype === Datatype.ATOMIC_URL &&
    typeof value === 'string'
  ) {
    return (
      <PropertyValue>
        <ResourceInline subject={value} />
      </PropertyValue>
    );
  }

  return <PropertyValue>{formatValue(value)}</PropertyValue>;
}

function formatValue(value: unknown): string {
  // The store flags removed properties by passing `null` through the
  // commit-log diff; surface that explicitly so the user can tell a
  // property-removal commit apart from one setting an empty string.
  if (value === null) {
    return '(removed)';
  }

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

const NodeAction = styled.button`
  background: none;
  border: none;
  color: ${p => p.theme.colors.main};
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0.2rem 0;

  &:hover {
    text-decoration: underline;
  }
`;

const Muted = styled.p`
  color: ${p => p.theme.colors.textLight};
`;

// --- Sync diagram ---

const statusColor = (
  status: NodeStatus,
  theme: { colors: Record<string, string> },
) => {
  switch (status) {
    case 'synced':
      return theme.colors.main;
    case 'syncing':
      return theme.colors.main;
    case 'unsynced':
      return theme.colors.warning;
    case 'offline':
      return theme.colors.alert;
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

const LocalDevice = styled.div`
  display: flex;
  align-items: center;
  gap: 1.25rem;
  padding: 2rem 1rem;
  margin-bottom: 2rem;
`;

const LocalDeviceBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
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

const NodeError = styled.div`
  display: inline-flex;
  align-items: flex-start;
  gap: 0.35rem;
  max-width: 14rem;
  color: ${p => p.theme.colors.alert};
  font-size: 0.8rem;
  line-height: 1.25;
  text-align: left;

  svg {
    flex-shrink: 0;
    margin-top: 0.12rem;
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

const LineTrack = styled.div<{ $offline: boolean }>`
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  top: 50%;
  border-top: 2px ${p => (p.$offline ? 'dashed' : 'solid')}
    ${p => p.theme.colors.bg2};
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

const heartbeat = keyframes`
  0% { left: 0%; }
  100% { left: calc(100% - 6px); }
`;

const HeartbeatDot = styled.div<{ $status: NodeStatus }>`
  position: absolute;
  top: calc(50% - 2px);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${p => statusColor(p.$status, p.theme)};
  animation: ${heartbeat} 2s ease-in-out infinite alternate;
`;

const PendingCount = styled.span`
  font-size: 0.8rem;
  font-weight: 600;
  color: ${p => p.theme.colors.warning};
  margin-left: 0.5rem;
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

const DriveSwitchTriggerButton = styled.button`
  appearance: none;
  background: none;
  border: none;
  color: ${p => p.theme.colors.main};
  cursor: pointer;
  font: inherit;
  margin: 0;
  max-width: 100%;
  overflow: hidden;
  padding: 0;
  text-align: start;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    text-decoration: underline;
  }

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
    outline-offset: 2px;
  }
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
  background: ${p => {
    switch (p.$status) {
      case 'failed':
        return p.theme.colors.warning + '22';
      case 'sent':
        return p.theme.colors.main + '22';
      case 'pending':
        // Same amber tone the previous PendingCount used.
        return '#d4960044';
      default:
        return p.theme.colors.bg2;
    }
  }};
  color: ${p => {
    switch (p.$status) {
      case 'failed':
        return p.theme.colors.warning;
      case 'sent':
        return p.theme.colors.main;
      case 'pending':
        return '#d49600';
      default:
        return p.theme.colors.textLight;
    }
  }};
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
  grid-template-columns: 1ch minmax(6rem, auto) minmax(0, 1fr);
  gap: 0.6rem;
  align-items: baseline;

  & > span[aria-hidden='true']:first-child {
    font-weight: 700;
    text-align: center;
    font-size: 0.85rem;
  }

  &[data-change-type='unchanged'] {
    opacity: 0.55;
  }
  &[data-change-type='removed'] {
    text-decoration: line-through;
    color: ${p => p.theme.colors.textLight};
  }
  &[data-change-type='changed'] > span[aria-hidden='true']:first-child {
    color: ${p => p.theme.colors.main};
  }
  &[data-change-type='removed'] > span[aria-hidden='true']:first-child {
    color: ${p => p.theme.colors.alert};
  }
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

const DebugToggle = styled.input`
  margin-right: 0.5rem;
  cursor: pointer;
`;

// These are spans (not divs) so they render legally inside <DetailValue>,
// which is itself a <span>. Using flex on a span still works fine.
const LocalDbStack = styled.span`
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
`;

const LocalDbRow = styled.span`
  display: flex;
  align-items: center;
  gap: 0.1rem;
`;

const LocalDbLabel = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const LocalDbError = styled.span`
  color: ${p => p.theme.colors.warning};
  white-space: pre-wrap;
  font-size: 0.85rem;
  display: block;
`;

const StatusDot = styled.span<{ $state: LocalDbStatus }>`
  display: inline-block;
  width: 0.55rem;
  height: 0.55rem;
  margin-right: 0.4rem;
  border-radius: 50%;
  background: ${p => {
    switch (p.$state) {
      case 'ready':
        return p.theme.colors.main;
      case 'error':
        return p.theme.colors.warning;
      case 'initializing':
        return p.theme.colors.textLight;
      case 'disabled':
      default:
        return p.theme.colors.bg2;
    }
  }};
  flex-shrink: 0;
`;

const ServerSelect = styled.select`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 0.3rem 0.5rem;
  font-size: 0.9rem;
  background: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  cursor: pointer;
`;

const AddServerRow = styled.form`
  display: flex;
  gap: 0.5rem;
  align-items: center;
`;

const PeerIdRow = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
`;

const PeerIdText = styled.code`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const DocsLink = styled.a`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const PeerRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0;
`;

const PeerLastSync = styled.span`
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
`;

const PeerSyncResult = styled.div<{ $error: boolean }>`
  font-size: 0.8rem;
  margin-top: 0.3rem;
  color: ${p => (p.$error ? p.theme.colors.warning : p.theme.colors.main)};
`;

const ServerInput = styled.input`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 0.3rem 0.5rem;
  font-size: 0.85rem;
  background: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  flex: 1;
  min-width: 0;
`;
