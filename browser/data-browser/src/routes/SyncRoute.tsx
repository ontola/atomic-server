import { useEffect, useState } from 'react';
import { createRoute } from '@tanstack/react-router';
import toast from 'react-hot-toast';
import {
  StoreEvents,
  type StoreSyncStatus,
  type CommitLogEntry,
  useStore,
  useProperty,
  truncateUrl,
  Datatype,
} from '@tomic/react';
import { styled, keyframes, css, type DefaultTheme } from 'styled-components';
import {
  cardSurface,
  CardIcon,
  CARD_SUB_FONT,
  CARD_TITLE_FONT,
} from '../components/cardSurface';
import { openExternal } from '../helpers/openExternal';
import {
  FaLaptop,
  FaServer,
  FaCheck,
  FaArrowsRotate,
  FaQuestion,
  FaCircleExclamation,
  FaCloud,
  FaPlus,
  FaMobileScreenButton,
  FaCloudArrowUp,
  FaKey,
} from 'react-icons/fa6';
import { Button } from '../components/Button';
import { VaultPanel } from '../components/Vault/VaultPanel';
import { LinkProviderPanel } from '../components/Vault/LinkProviderPanel';
import { isDeviceLinked } from '../helpers/managed/deviceLink';
import {
  getManagedAccount,
  type ManagedAccount,
} from '../helpers/managed/session';
import { getRememberedManagedPortalUrl } from '../helpers/managed/api';
import { getRecoverySecret } from '../helpers/managed/recovery';
import { useDriveVault } from '../helpers/managed/useDriveVault';
import { ContainerNarrow } from '../components/Containers';
import { Main } from '../components/Main';
import { Card } from '../components/Card';
import {
  fetchManagedInfo,
  type ManagedInfo,
  EMPTY_NODE_INFO,
  fetchNodeDriveUsage,
  forgetServerPeer,
  type NodeDriveUsage,
} from '../helpers/managedServer';
import { getDriveUsage } from '../helpers/managedUsage';
import {
  normalizeServerUrl,
  sameOrigin,
  serverLabel,
} from '../helpers/serverUrl';
import { ResourceInline } from '../views/ResourceInline';
import { AtomicLink } from '../components/AtomicLink';
import { formatTimeAgo } from '../helpers/formatTimeAgo';
import {
  getLocalServerOrigin,
  isMobileTauri,
  isRunningInTauri,
} from '../helpers/tauri';
import { deviceHasDriveData } from '../helpers/driveData';
import { deliverDeepLink } from '../helpers/deepLinkQueue';
import { PairingCode } from '../components/PairingCode';
import { ConnectToDeviceForm } from '../components/ConnectToDeviceForm';
import {
  decodePairingEnvelope,
  PairingEnvelopeError,
  PAIRING_URI_PREFIX,
} from '@tomic/lib';
import { isClientDbEnabled, setClientDbEnabled } from '../helpers/clientDbMode';
import { PRODUCT_NAME } from '../helpers/managed/product';
import {
  enableCloudSyncForDrive,
  ensureManagedSession,
  driveHasCloudEnrollment,
  isCloudSyncAvailable,
  getManagedPortalUrl,
} from '../helpers/managed/cloudSync';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';
import { useSettings } from '../helpers/AppSettings';
import { serverURLStorage } from '../helpers/serverURLStorage';

export const SyncRoute = createRoute({
  path: pathNames.sync,
  component: () => <SyncPage />,
  getParentRoute: () => appRoute,
});

type NodeStatus = 'synced' | 'syncing' | 'unsynced' | 'offline' | 'unknown';
type KnownPeer = { nodeId: string; label: string; lastSync?: string };

const NODE_DID_PREFIX = 'did:ad:node:';

function nodeDidToRaw(nodeDid: string): string | undefined {
  if (!nodeDid.startsWith(NODE_DID_PREFIX)) return undefined;

  const raw = nodeDid.slice(NODE_DID_PREFIX.length).split(':')[0];

  return /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : undefined;
}

function rawToNodeDid(raw: string): string {
  return `${NODE_DID_PREFIX}${raw}`;
}

function normalizeStoredPeer(peer: KnownPeer): KnownPeer | undefined {
  if (nodeDidToRaw(peer.nodeId)) return peer;

  return undefined;
}

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
      return 'Syncing…';
    case 'unsynced':
      return 'Changes pending';
    case 'offline':
      return 'Offline';
    case 'unknown':
      return 'Connecting…';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

type ServerCardProps = {
  server: string;
  status: StoreSyncStatus;
  managedInfo: ManagedInfo;
  /** Sync status of the server actually in use. */
  serverStatus: NodeStatus;
  hasWorkingLocalStore: boolean;
  nodeUsage: NodeDriveUsage | null;
  quotaBytes: number | null;
  serverNodeId: string | null;
  onSwitch: (server: string) => void;
  onRemove: (server: string) => void;
};

/**
 * One server, as a card.
 *
 * Rendered in two places, which is why it is a component: a managed node is no
 * longer listed among the devices, because it is one of the provider's
 * services and belongs inside the account card. Both places want the same
 * content — status, usage, node id, the way to disconnect — and one renderer
 * is what stops the two copies drifting.
 *
 * At module scope with every input passed in, even though all of them are to
 * hand in `SyncPage`. A component declared inside another component is a fresh
 * type on every parent render, so React remounts the subtree rather than
 * updating it — which for this card means throwing away a live connection's
 * DOM on every keystroke elsewhere on the page.
 */
function ServerCard({
  server,
  status,
  managedInfo,
  serverStatus,
  hasWorkingLocalStore,
  nodeUsage,
  quotaBytes,
  serverNodeId,
  onSwitch,
  onRemove,
}: ServerCardProps) {
  const store = useStore();
  const isActive = sameOrigin(server, status.serverUrl);
  const isCloud = isActive && managedInfo.managed;
  const serverHostname = status.serverUrl
    ? new URL(status.serverUrl).hostname
    : undefined;
  const usagePct =
    nodeUsage && quotaBytes
      ? Math.min(
          100,
          Math.round(
            ((nodeUsage.blobBytes + nodeUsage.loroBytes) / quotaBytes) * 100,
          ),
        )
      : null;

  const syncedAgo = status.lastDriveSync
    ? formatTimeAgo(new Date(status.lastDriveSync.timestamp))
    : null;
  const usedBytes = nodeUsage
    ? nodeUsage.blobBytes + nodeUsage.loroBytes
    : null;
  /**
   * What is true of the server in use, as whole phrases joined by a dot.
   *
   * Assembled here rather than written inline in the JSX for two reasons.
   * Interpolated text placed directly inside a `&&` guard extracts wrong —
   * wuchale keeps the leading literal and drops the arguments, so at runtime
   * the lookup wants more placeholders than the catalogue entry has and the
   * line renders as `[i18n-404:…]`. And a translator given a whole phrase can
   * reorder it, which is the whole point; given `resources ·` and ` of ` they
   * cannot.
   *
   * Each phrase has to start with a capital or a placeholder: wuchale's
   * default heuristic drops script-scope strings with a lower-case beginning,
   * on the reasoning that those are usually identifiers rather than prose. A
   * dropped string is not an error, it is simply never translated — which is
   * the quiet failure, so it is worth knowing about.
   */
  const facts: string[] = [];

  if (nodeUsage && usedBytes !== null) {
    facts.push(`${nodeUsage.resourceCount.toLocaleString()} resources`);
    facts.push(
      quotaBytes
        ? `${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)}`
        : formatBytes(usedBytes),
    );
  }

  if (status.lastDriveSync) {
    facts.push(syncedAgo ? `Synced ${syncedAgo}` : 'Synced just now');
  }

  return (
    <ConnCard $active={isActive} $provider={isCloud}>
      <CardIcon $tone={isCloud ? 'provider' : 'neutral'}>
        {isCloud ? <FaCloud /> : <FaServer />}
      </CardIcon>
      <ConnBody>
        <ConnTopRow>
          <ConnTitle>
            {isCloud ? 'Cloud Server' : serverLabel(server)}
          </ConnTitle>
          <ConnTopRight>
            {isActive ? (
              <>
                <StatusPill $status={serverStatus}>
                  <StatusIcon status={serverStatus} />
                  {statusLabel(serverStatus)}
                </StatusPill>
                {status.serverConnected ? (
                  // Without a working local store (embedded node or
                  // ready OPFS cache), the server is the only data
                  // source — disconnecting would leave the app with
                  // no data at all.
                  <NodeAction
                    onClick={() => store.disconnect()}
                    disabled={!hasWorkingLocalStore}
                    title={
                      hasWorkingLocalStore
                        ? undefined
                        : 'Local storage is off, so this server is the only data source. Enable local storage below to work disconnected.'
                    }
                  >
                    Disconnect
                  </NodeAction>
                ) : (
                  <NodeAction
                    onClick={() =>
                      store.reconnect().catch(e => store.notifyError(e))
                    }
                  >
                    Reconnect
                  </NodeAction>
                )}
              </>
            ) : (
              <>
                <StatusPill $status='unknown'>Not connected</StatusPill>
                <NodeAction onClick={() => onSwitch(server)}>Switch</NodeAction>
              </>
            )}
          </ConnTopRight>
        </ConnTopRow>

        <ConnSub>
          {isActive
            ? isCloud
              ? serverHostname
              : 'Always-on · in use'
            : 'Always-on device'}
        </ConnSub>

        {/* Status details belong to the server actually in use. */}
        {isActive &&
          !status.serverConnected &&
          status.serverConnectionError && (
            <ConnError role='alert'>
              <FaCircleExclamation aria-hidden />
              <span>{status.serverConnectionError}</span>
            </ConnError>
          )}

        {isActive && usagePct !== null && (
          <UsageBar
            aria-label={`${usagePct}% of storage used`}
            title={`${usagePct}% used`}
          >
            <UsageFill style={{ width: `${usagePct}%` }} />
          </UsageBar>
        )}

        {isActive && facts.length > 0 && (
          <ConnMeta>{facts.join(' · ')}</ConnMeta>
        )}

        {/* A node id identifies this server's node, so it belongs on
                    the server — not buried in Developer. */}
        {isActive && serverNodeId && (
          <NodeIdRow>
            <NodeIdLabel>Node ID</NodeIdLabel>
            <NodeIdValue
              title={`Copy ${rawToNodeDid(serverNodeId)}`}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    rawToNodeDid(serverNodeId),
                  );
                  toast.success('Node ID copied');
                } catch (e) {
                  store.notifyError(e as Error);
                }
              }}
            >
              {rawToNodeDid(serverNodeId)}
            </NodeIdValue>
          </NodeIdRow>
        )}

        {isCloud && managedInfo.portalUrl && (
          <ConnActions>
            <ManagedLink
              // The dashboard, not the portal root: signed-in
              // visitors get the marketing page at `/`, so the
              // link landed on a sales pitch rather than the
              // account it promises to manage.
              href={`${managedInfo.portalUrl}/dashboard`}
              target='_blank'
              rel='noopener noreferrer'
            >
              {'Manage account & plan →'}
            </ManagedLink>
          </ConnActions>
        )}
        {/* Removing the server you're using would strand the app. */}
        {!isActive && (
          <ConnActions>
            <NodeActionSubtle onClick={() => onRemove(server)}>
              Remove
            </NodeActionSubtle>
          </ConnActions>
        )}
      </ConnBody>
    </ConnCard>
  );
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
  const [knownServers, setKnownServers] = useState<string[]>(() =>
    serverURLStorage.getKnownServers(),
  );

  // New servers are persisted by `setServer` (through `serverURLStorage`), and
  // AppSettings registers the current origin on mount — neither can reach this
  // state, so without re-reading, a server you just added only shows up after a
  // reload. `baseURL` changes on every add and switch, which is the signal.
  useEffect(() => {
    setKnownServers(serverURLStorage.getKnownServers());
  }, [baseURL]);

  // Switching + adding happen inline in the Devices section (not a separate
  // dialog): `showAddServer` reveals the add-a-device form. An always-on device
  // is added by address; one you carry is added by pairing with its code.
  const [showAddServer, setShowAddServer] = useState(false);
  const [serverInput, setServerInput] = useState('');
  const [localNodeId, setLocalNodeId] = useState<string | null>(null);
  const [peerSyncing, setPeerSyncing] = useState(false);
  const [peerSyncResult, setPeerSyncResult] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  // Cloud Server (SaaS) hosting state for the active drive. `null` = not yet
  // known / not applicable; `false` = eligible but not enrolled (show the CTA);
  // `true` = already enrolled (hide it).
  const [cloudEnrolled, setCloudEnrolled] = useState<boolean | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  // Resolved in an effect rather than read off a Resource during render: the
  // React Compiler memoizes on the proxy identity, so a resource that finishes
  // loading would never re-render this.
  const [driveMissing, setDriveMissing] = useState(false);
  const [knownPeers, setKnownPeers] = useState<KnownPeer[]>(() => {
    try {
      return (
        JSON.parse(localStorage.getItem('atomic-peers') ?? '[]') as KnownPeer[]
      )
        .map(normalizeStoredPeer)
        .filter((peer): peer is KnownPeer => peer !== undefined);
    } catch {
      return [];
    }
  });

  // What the server in use says about itself, read from its `/server` resource:
  // its node id and version, plus whether it is a managed node and where its
  // dashboard lives. The managed flag and portal URL are the ONLY things the
  // FOSS data-browser knows about "being managed" — self-hosted servers report
  // `managed:false` and no portal link is shown; anything plan/billing-specific
  // lives behind the link, on the operator's portal.
  const [managedInfo, setManagedInfo] = useState<ManagedInfo>(EMPTY_NODE_INFO);

  // Cloud Vault. Assembling its prerequisites (wasm key ops, this install's
  // lane id, the signing agent) lives in the hook, which the wiped-device
  // onboarding screen uses too — both have to agree about whether a vault
  // exists for this drive.
  const vault = useDriveVault(status.drive ?? null);

  /**
   * Does this client need to link before it can reach the provider at all?
   *
   * True only when nothing is linked yet and `/api/me` says there is no
   * session — the state a self-hosted, desktop or Android client starts in,
   * and never the state of a browser served from the provider's own site.
   *
   * Deliberately not gated on the vault's own status: the vault reports
   * `unavailable` only once it has an agent, a drive and its wasm keys to ask
   * with. A fresh install has none of those and sits at `loading`, so gating
   * on it hid the one control that could have fixed the situation.
   */
  const [needsProviderLink, setNeedsProviderLink] = useState(false);

  /**
   * The provider account this client is signed in to, if any.
   *
   * Kept rather than reduced to a boolean because the account is what earns a
   * link back to the portal, and that relationship exists independently of any
   * managed node: Cloud Vault is blind backup and needs no hosting, so a user
   * can be signed in with nothing managed in sight.
   */
  const [managedAccount, setManagedAccount] = useState<ManagedAccount | null>(
    null,
  );

  /**
   * Whether the account holds an encrypted recovery backup.
   *
   * `null` until asked, and on failure — "we could not check" is not "you have
   * none", and telling someone their recovery is missing when the control
   * plane was merely unreachable is the one wrong answer this row can give.
   */
  const [hasRecoveryBackup, setHasRecoveryBackup] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    if (!managedAccount) return;

    let cancelled = false;

    void (async () => {
      try {
        const secret = await getRecoverySecret();

        if (!cancelled) setHasRecoveryBackup(secret !== null);
      } catch {
        if (!cancelled) setHasRecoveryBackup(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [managedAccount]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Asked even when this device is already linked. The link only settles
      // *how* this client authenticates; it says nothing about who, and the
      // portal link needs the account itself.
      const linked = isDeviceLinked();

      try {
        const account = await getManagedAccount();

        if (cancelled) return;

        setManagedAccount(account);
        setNeedsProviderLink(!linked && account === null);
      } catch {
        // Unreachable control plane. Offering to link is the useful answer —
        // the alternative is a Sync page that silently omits backup with no
        // way to ask for it.
        if (!cancelled) setNeedsProviderLink(!linked);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const serverUrl = status.serverUrl;

    if (!serverUrl) {
      setManagedInfo(EMPTY_NODE_INFO);

      return;
    }

    let cancelled = false;

    const poll = () =>
      fetchManagedInfo(serverUrl).then(info => {
        if (!cancelled) setManagedInfo(info);
      });

    void poll();

    // Re-poll so a device connecting or dropping shows up without a reload —
    // `peer/live` is a moment-to-moment fact, not a one-time read. Version and
    // node id don't change, so this is cheap and idempotent.
    const timer = setInterval(poll, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status.serverUrl]);

  // Re-read per server, never carried across a switch: a node id belongs to one
  // node, so a stale one on a server card would lie about who you're talking to.
  const serverNodeId = managedInfo.nodeId
    ? (nodeDidToRaw(managedInfo.nodeId) ?? null)
    : null;

  // Resource count + bytes from the connected node's `/drive-usage` — generic,
  // works on any atomic-server (self-hosted included). Signed with the agent
  // because the endpoint enforces read access to the drive.
  const [nodeUsage, setNodeUsage] = useState<NodeDriveUsage | null>(null);

  // Sign in with a secret on a fresh device and you get the identity but none
  // of the data. Detect that so the page can lead with "pair a device".
  useEffect(() => {
    const drive = status.drive;

    if (!drive || !store.getAgent()) {
      setDriveMissing(false);

      return;
    }

    let cancelled = false;

    deviceHasDriveData(store, drive).then(present => {
      if (!cancelled) {
        setDriveMissing(!present);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [status.drive, store]);

  useEffect(() => {
    const drive = status.drive;
    const serverUrl = status.serverUrl;
    const agent = store.getAgent();

    // A local-only drive isn't on the server — asking for its usage 500s.
    if (!drive || !serverUrl || !agent || store.isLocalOnlyDrive(drive)) {
      setNodeUsage(null);

      return;
    }

    let cancelled = false;
    fetchNodeDriveUsage(serverUrl, drive, agent)
      .then(usage => {
        if (!cancelled) setNodeUsage(usage);
      })
      .catch(() => {
        if (!cancelled) setNodeUsage(null);
      });

    return () => {
      cancelled = true;
    };
  }, [status.drive, status.serverUrl, store]);

  // Plan quota — managed nodes only, from the control plane. Billing stays a
  // managed concern; the usage numbers above are generic to every node.
  const [quotaBytes, setQuotaBytes] = useState<number | null>(null);

  useEffect(() => {
    const drive = status.drive;

    if (!managedInfo.portalUrl || !drive || store.isLocalOnlyDrive(drive)) {
      setQuotaBytes(null);

      return;
    }

    let cancelled = false;
    getDriveUsage(drive)
      .then(info => {
        if (!cancelled) setQuotaBytes(info?.quotaBytes ?? null);
      })
      .catch(() => {
        if (!cancelled) setQuotaBytes(null);
      });

    return () => {
      cancelled = true;
    };
  }, [managedInfo.portalUrl, status.drive]);

  useEffect(() => {
    // Absolute origin, not a bare path: inside the Tauri webview a bare
    // `/server` resolves against `tauri.localhost` (the bundled assets), not
    // the embedded atomic-server — so the node identity (and the whole pairing
    // UI it gates) would never load on desktop/mobile.
    fetchManagedInfo(getLocalServerOrigin())
      .then(info => {
        if (!info.nodeId) return;

        const raw = nodeDidToRaw(info.nodeId);

        if (!raw) return;

        setLocalNodeId(raw);
      })
      .catch(() => {});
  }, []);

  // Does the active drive already have a Cloud Server enrollment? Drives the
  // Cloud Server CTA below. Skips entirely when no control plane is
  // reachable (pure self-hosted), so the CTA never shows there.
  useEffect(() => {
    const drive = status.drive;

    if (!drive || !isCloudSyncAvailable(managedInfo)) {
      setCloudEnrolled(null);

      return;
    }

    let cancelled = false;
    driveHasCloudEnrollment(drive)
      .then(has => {
        if (!cancelled) setCloudEnrolled(has);
      })
      .catch(() => {
        if (!cancelled) setCloudEnrolled(false);
      });

    return () => {
      cancelled = true;
    };
  }, [status.drive, managedInfo]);

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

  // Whose code to show. Inside the Tauri shell this app is itself a node, so
  // it shows its own. A browser tab is not a node and never will be — but the
  // always-on device it is signed in to is one, and that is the device another
  // of yours should reach. Either way a code is a node id, and a node id needs
  // no address, port or certificate to dial: that is the point of Iroh.
  const isNode = isRunningInTauri();
  const pairNodeId = isNode ? localNodeId : serverNodeId;
  // A local-only drive (the demo, or any drive made offline) is a normal
  // drive the sync engine was simply told to skip — not a special code path.
  // When the active drive is local-only the "syncs with N places" story is a
  // lie for it, so the page leads with an honest, drive-specific state + the
  // option to start syncing it.
  const localOnlyDrive = !!status.drive && store.isLocalOnlyDrive(status.drive);
  // Whether this device holds a usable copy of the data on its own: the
  // embedded node (Tauri) or an enabled AND actually-running OPFS cache.
  // `clientDbOn` alone isn't enough — the toggle only takes effect after a
  // reload, and the worker can park in server-only mode (lock contention,
  // insecure context), in which case the server is still the only source.
  const hasWorkingLocalStore =
    isNode || (clientDbOn && status.clientDbReady && !status.clientDbError);
  const serverHostname = status.serverUrl
    ? new URL(status.serverUrl).hostname
    : undefined;
  const embeddedActive =
    isNode &&
    (serverHostname === 'localhost' || serverHostname === '127.0.0.1');
  // Show a server connection card whenever the active server isn't this
  // device's own embedded one (browser: always; Tauri: only a real remote).
  const showServerConn = !!status.serverUrl && !embeddedActive;
  const pairedPeers = isNode ? knownPeers : [];
  // A browser is not a node, so it cannot pair with a device itself. But the
  // server it reads from can — and reports who, over `/server`. So a phone
  // paired with your server shows up here, as the server sees it. These are
  // display-only: reaching them is the server's job, not this tab's.
  const serverPeers = isNode ? [] : (managedInfo.peers ?? []);
  const connectionCount =
    (showServerConn ? 1 : 0) + pairedPeers.length + serverPeers.length;

  // Every known server, in one stable list — the active one is *styled*, not
  // moved. Rendering the active server as its own card above the rest made the
  // list reshuffle on every switch, which is disorienting. In the Tauri shell
  // the embedded localhost is "This device", not a connection, so it's excluded
  // there (same rule as `embeddedActive`).
  const connectionServers = knownServers.filter(server => {
    if (!isNode) {
      return true;
    }

    try {
      const { hostname } = new URL(server);

      return hostname !== 'localhost' && hostname !== '127.0.0.1';
    } catch {
      return false;
    }
  });

  // Offer Cloud Server only for a drive that lives on this device (a
  // local-only drive, or the embedded node with no remote server) and isn't
  // already enrolled. A drive already homed on a remote server is a migration,
  // not a backup — out of scope for this action.
  const deviceLocalDrive =
    !!status.drive && (localOnlyDrive || !showServerConn);
  const showCloudBackup =
    isCloudSyncAvailable(managedInfo) &&
    cloudEnrolled === false &&
    deviceLocalDrive &&
    !driveMissing;

  /**
   * Why Cloud Server can't be switched on from here, or null when it can.
   *
   * The row itself is unconditional once an account is known: a service that
   * vanishes when it is off cannot be discovered, and "is this on?" is exactly
   * the question this card exists to answer. But most of the reasons it can't
   * be enabled right now are about *this device* rather than about the
   * product, and saying which one is the difference between a page that reads
   * as broken and one that reads as informative.
   *
   * The order matters: each line assumes the ones above it are false. `null`
   * here is the same condition as `showCloudBackup`, by construction.
   */
  function cloudServerBlocker(): string | null {
    if (!status.drive) {
      return 'Open a workspace to see whether it can be hosted.';
    }

    if (driveMissing) {
      return 'This device doesn’t have this workspace yet. Pair the device that does, and you can host it from here.';
    }

    if (cloudEnrolled === true) {
      return `Already set up for this workspace. This app is reading from ${serverHostname ?? 'another server'} instead.`;
    }

    if (!isCloudSyncAvailable(managedInfo)) {
      return `${serverHostname ?? 'This server'} doesn’t offer hosting, so it can’t be switched on from here.`;
    }

    if (cloudEnrolled === null) {
      return 'Checking whether this workspace is hosted…';
    }

    if (!deviceLocalDrive) {
      return `This workspace already lives on ${serverHostname ?? 'another server'}. Moving it here is a migration, not a backup.`;
    }

    return null;
  }

  /** Evaluated once: three JSX call sites want the same answer. */
  const cloudServerBlocked = cloudServerBlocker();

  function summaryLine(): string {
    if (localOnlyDrive) {
      return 'This workspace is stored only on this device — it isn’t backed up or synced anywhere.';
    }

    if (!isNode && !clientDbOn) {
      return 'Your data lives on the device you’re connected to.';
    }

    if (connectionCount === 0) {
      return 'Your data lives on this device — it isn’t syncing anywhere yet.';
    }

    return `Your data lives on this device and syncs with ${connectionCount} other ${
      connectionCount === 1 ? 'device' : 'devices'
    }.`;
  }

  /** The provider's own node, when this drive is on one. */
  const managedServer =
    connectionServers.find(server => isManagedServer(server)) ?? null;

  /** Is this one of ours? Mirrors `isCloud` inside the card renderer. */
  function isManagedServer(server: string): boolean {
    return sameOrigin(server, status.serverUrl) && managedInfo.managed;
  }

  /**
   * A sales-page link for one tier, carrying what it would apply to.
   *
   * The portal only lists prices today, but buying a tier is per drive (that is
   * how Cloud Server placement and Cloud Vault storage are both costed), so a
   * checkout will need to know which drive and which agent it is selling to.
   * Both identifiers are already on this page and both are public DIDs — the
   * agent's *secret* never leaves the device — so passing them costs nothing
   * now and saves the round trip later. Unknown values are omitted rather than
   * sent empty.
   */
  function tierOfferUrl(portalUrl: string, tier: 'vault' | 'server'): string {
    const url = new URL(portalUrl);
    url.searchParams.set('tier', tier);

    if (status.drive) url.searchParams.set('drive', status.drive);

    const agentSubject = store.getAgent()?.subject;

    if (agentSubject) url.searchParams.set('agent', agentSubject);

    url.hash = 'pricing';

    return url.toString();
  }

  /**
   * Where to send someone who holds an account.
   *
   * Same sources as the Cloud Server CTA, then the control plane a managed
   * node named earlier in this install's life. That fallback is what makes the
   * link work on a device whose active node is unmanaged — a desktop app on
   * its own embedded node, say — without inventing a URL for a node that has
   * never heard of a portal.
   */
  const accountPortalUrl =
    getManagedPortalUrl(managedInfo) ?? getRememberedManagedPortalUrl();

  async function promoteDrive() {
    if (!status.drive || promoting) return;
    setPromoting(true);

    try {
      await store.promoteLocalDrive(status.drive);
      toast.success('Syncing this workspace…');
    } catch (e) {
      store.notifyError(e as Error);
    } finally {
      setPromoting(false);
    }
  }

  async function backupToCloud() {
    const drive = status.drive;
    const agent = store.getAgent();
    // Enrollment is keyed on the agent's subject: without one there is no
    // identity to attach the backup to.
    const agentSubject = agent?.subject;

    if (!drive || !agentSubject || cloudBusy) return;

    setCloudBusy(true);

    try {
      const args = {
        store,
        drive,
        agentSubject,
        setServer,
        managedInfo,
      };
      let result = await enableCloudSyncForDrive(args);

      if (!result.ok) {
        // No account/session yet. Open the portal (in-app window on desktop,
        // popup on web) so the user signs in / creates an account there; it
        // shares our cookie jar, so once done we just retry — no token handoff.
        if (!result.portalUrl) {
          toast.error(
            `No ${PRODUCT_NAME} portal is configured for this server.`,
          );

          return;
        }

        const signedIn = await ensureManagedSession(result.portalUrl);

        if (!signedIn) {
          toast(`Sign-in wasn’t completed — nothing was backed up.`);

          return;
        }

        result = await enableCloudSyncForDrive(args);

        if (!result.ok) {
          toast.error(`Could not enable ${PRODUCT_NAME} backup.`);

          return;
        }
      }

      setCloudEnrolled(true);
      toast.success(`Backing up this workspace to ${PRODUCT_NAME}…`);
    } catch (e) {
      store.notifyError(e as Error);
    } finally {
      setCloudBusy(false);
    }
  }

  function savePeers(peers: KnownPeer[]) {
    setKnownPeers(peers);
    localStorage.setItem('atomic-peers', JSON.stringify(peers));
  }

  async function disconnectServerPeer(nodeId: string) {
    const agent = store.getAgent();
    const serverUrl = status.serverUrl;

    if (!agent || !serverUrl) return;

    // Drop it locally right away so the card disappears; the server forgets the
    // reconnect entry and closes the live connection. A refetch reconciles.
    setManagedInfo(prev => ({
      ...prev,
      peers: (prev.peers ?? []).filter(p => p.nodeId !== nodeId),
    }));

    const ok = await forgetServerPeer(serverUrl, nodeId, agent);

    if (!ok) {
      setPeerSyncResult('Error: could not disconnect that device');
    }

    fetchManagedInfo(serverUrl).then(setManagedInfo);
  }

  async function syncWithPeer(input: string) {
    if (!input || !status.drive) return;

    // A pasted atomic://pair link is routing sugar for the same thing: pull
    // the node identity out of the envelope.
    let nodeDid = input;

    if (input.startsWith(PAIRING_URI_PREFIX)) {
      try {
        nodeDid = decodePairingEnvelope(input).node;
      } catch (e) {
        setPeerSyncResult(
          `Error: ${e instanceof PairingEnvelopeError ? e.message : e}`,
        );

        return;
      }
    }

    const rawNodeId = nodeDidToRaw(nodeDid);

    if (!rawNodeId) {
      setPeerSyncResult(`Error: Expected ${NODE_DID_PREFIX}<node-id>`);

      return;
    }

    const canonicalNodeDid = rawToNodeDid(rawNodeId);

    setPeerSyncing(true);
    setPeerSyncResult(null);

    try {
      const res = await fetch(`${getLocalServerOrigin()}/iroh-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: canonicalNodeDid, drive: status.drive }),
      });
      const data = await res.json();

      if (data.error) {
        setPeerSyncResult(`Error: ${data.error}`);
      } else {
        // `peerName` is the remote's self-reported HELLO label. New servers
        // populate it; older builds return null. Fall back to the truncated
        // Node DID so the entry always has *something* to display.
        const peerName: string | undefined =
          typeof data.peerName === 'string' && data.peerName.trim()
            ? data.peerName.trim()
            : undefined;
        const didFallback = `${NODE_DID_PREFIX}${rawNodeId.slice(0, 8)}...`;
        // Say what moved in each direction. A pass that sends 49 and receives 1
        // is not "1 resource synced", and reporting it that way hides whether
        // the link works at all.
        const received: number =
          typeof data.count === 'number' ? data.count : 0;
        const sent: number = typeof data.pushed === 'number' ? data.pushed : 0;
        const withWhom = peerName ? ` with ${peerName}` : '';
        const msg =
          received === 0 && sent === 0
            ? `Already up to date${withWhom}`
            : `Synced${withWhom} — sent ${sent}, received ${received}`;
        setPeerSyncResult(msg);

        const existing = knownPeers.findIndex(
          p => nodeDidToRaw(p.nodeId) === rawNodeId,
        );
        const entry: KnownPeer = {
          nodeId: canonicalNodeDid,
          label: peerName ?? didFallback,
          lastSync: new Date().toISOString(),
        };

        if (existing >= 0) {
          const updated = [...knownPeers];
          updated[existing] = entry;
          savePeers(updated);
        } else {
          savePeers([...knownPeers, entry]);
        }
      }
    } catch (e) {
      setPeerSyncResult(`Error: ${e}`);
    }

    setPeerSyncing(false);
  }

  function removePeer(nodeId: string) {
    savePeers(knownPeers.filter(p => p.nodeId !== nodeId));
  }

  /** Point the app at `server` and reconnect. `setServer` runs through
   * `store.setServerUrl`, which reopens the WebSocket — the connection card
   * then reflects the new server's status. The toast is the immediate feedback
   * (the reconnect itself is async). */
  function switchToServer(server: string) {
    if (server === baseURL) {
      return;
    }

    try {
      setServer(server);
      toast.success(`Switching to ${serverLabel(server)}…`);
    } catch (e) {
      store.notifyError(e as Error);
    }
  }

  function removeServer(server: string) {
    serverURLStorage.removeKnownServer(server);
    setKnownServers(serverURLStorage.getKnownServers());
  }

  return (
    <Main>
      <ContainerNarrow>
        <h1>Sync</h1>
        <Lead>{summaryLine()}</Lead>

        {/* Everything our paid services own, in one card.

            These used to be loose entries in the Devices list, on the reasoning
            that a person does not think of "this device", "the backup" and "the
            hosted workspace" as different kinds of thing — they are all places
            the same data lives. True as far as it goes, but it left no answer to
            a different question the page is also asked: which of this is a
            product I am paying for, and where do I go to manage it. Grouping
            under the account answers that without returning to the old stack of
            free-floating offer cards, because this is one card, not three.

            Gated on a portal being known at all, so a self-hosted node with no
            control plane renders none of it. That URL comes from a managed
            node, a build-time override, or one a node named earlier — never
            from anything hardcoded here. */}
        {accountPortalUrl && (
          <ProviderCard data-testid='provider-card'>
            <ProviderHeader>
              <CardIcon $tone='provider'>
                <FaCloud />
              </CardIcon>
              <AccountBody>
                <AccountLabel>{PRODUCT_NAME}</AccountLabel>
                <AccountEmail data-testid='provider-account'>
                  {managedAccount
                    ? 'Your cloud services'
                    : 'Cloud services for this workspace'}
                </AccountEmail>
              </AccountBody>
              {managedAccount && (
                <ManagedLink
                  // The dashboard, not the portal root: a signed-in visitor
                  // gets the marketing page at `/`, so the link would land on
                  // a sales pitch rather than the account it promises to
                  // manage.
                  href={`${accountPortalUrl}/dashboard`}
                  target='_blank'
                  rel='noopener noreferrer'
                >
                  {'Manage account →'}
                </ManagedLink>
              )}
            </ProviderHeader>

            {/* Email recovery. Blue when it is actually set up, which is the
                rule for every row here: colour answers "is this on", not "does
                this exist". Left neutral while unknown too — a failed check
                must not be drawn as a missing backup. */}
            {managedAccount && (
              <ProviderService data-testid='recovery-row'>
                <CardIcon $tone={hasRecoveryBackup ? 'provider' : 'neutral'}>
                  <FaKey />
                </CardIcon>
                <ConnBody>
                  <ConnTitle>Email recovery</ConnTitle>
                  <ConnSub>
                    {hasRecoveryBackup === null
                      ? `Signed in as ${managedAccount.email}.`
                      : hasRecoveryBackup
                        ? `${managedAccount.email} — we hold your key sealed, so this email gets you back in on a new device.`
                        : `${managedAccount.email} — no recovery backup stored. Lose every device and this workspace is gone.`}
                  </ConnSub>
                </ConnBody>
              </ProviderService>
            )}

            {/* Unconditional, like the other two: a service that disappears
                when it is off cannot be found, and the question this card
                answers is "is this on". `VaultPanel` renders every state
                itself, including the seconds it spends deciding. */}
            <ProviderService>
              <VaultPanel
                vault={vault}
                embedded
                offerUrl={tierOfferUrl(accountPortalUrl, 'vault')}
                onOfferClick={url => void openExternal(url)}
                onRestored={() => window.location.reload()}
              />
            </ProviderService>

            {/* On: the managed node itself, rendered by the same function the
                Devices list uses, so the two cannot drift. Off: the offer,
                which stays on the page in every other state — with the reason
                in place of the button when there is nothing to press. */}
            {managedServer ? (
              <ProviderService data-testid='cloud-server-row'>
                <ServerCard
                  server={managedServer}
                  status={status}
                  managedInfo={managedInfo}
                  serverStatus={nodes.server}
                  hasWorkingLocalStore={hasWorkingLocalStore}
                  nodeUsage={nodeUsage}
                  quotaBytes={quotaBytes}
                  serverNodeId={serverNodeId}
                  onSwitch={switchToServer}
                  onRemove={removeServer}
                />
              </ProviderService>
            ) : (
              <ProviderService data-testid='cloud-server-row'>
                {/* Glyph blue, card neutral: an offer should be findable as
                    one of ours without being mistaken for a live service. */}
                <CardIcon $tone='provider'>
                  <FaCloud />
                </CardIcon>
                <ConnBody>
                  <ConnTitle>Cloud Server</ConnTitle>
                  <ConnSub>
                    A hosted workspace on {PRODUCT_NAME}: shareable links,
                    search across everything, API access, and no waiting on
                    another device to be awake. Unlike Cloud Vault, our servers
                    process what you put here.
                  </ConnSub>
                  {cloudServerBlocked && (
                    <ConnMeta>{cloudServerBlocked}</ConnMeta>
                  )}
                  <ConnActions>
                    {!cloudServerBlocked && (
                      <Button onClick={backupToCloud} disabled={cloudBusy}>
                        {cloudBusy ? 'Setting up…' : 'Set up Cloud Server'}
                      </Button>
                    )}
                    {/* This tier costs money and reads our copy of your data,
                        so "what am I agreeing to" deserves an answer that
                        isn't a paragraph on this card. The sales page already
                        explains the tiers side by side.

                        Linked off the *account's* portal, not the connected
                        node's: the states that most need a price are the ones
                        where this device is talking to a node that has never
                        heard of a portal. */}
                    <LearnMore
                      href={tierOfferUrl(accountPortalUrl, 'server')}
                      // No `_blank` in the app: Tauri intercepts a new-window
                      // request natively, before the click handler can cancel
                      // it, and hands it to `shell.open` — which is denied and
                      // then fails on Android regardless. The href stays real
                      // either way, so this is still a link to assistive tech
                      // and to "copy link address".
                      target={isNode ? undefined : '_blank'}
                      rel='noreferrer'
                      onClick={e => {
                        e.preventDefault();
                        void openExternal(
                          tierOfferUrl(accountPortalUrl, 'server'),
                        );
                      }}
                    >
                      See plans
                    </LearnMore>
                  </ConnActions>
                </ConnBody>
              </ProviderService>
            )}
          </ProviderCard>
        )}

        {/* Signed in, but this device holds none of the account's data — it's
            still on whatever device created it. Pairing is the way across, so
            lead with it. Takes precedence over the local-only notice below:
            there is nothing here to promote. */}
        {driveMissing && (
          <LocalDriveNotice>
            <CardIcon>
              <FaMobileScreenButton />
            </CardIcon>
            <ConnBody>
              <ConnTitle>Your data is on another device</ConnTitle>
              <ConnSub>
                {/* Either code below brings it over: this device's when it is a
                    node, otherwise the server's — the other device scans it and
                    syncs the drive somewhere this one can read. */}
                {pairNodeId
                  ? 'You’re signed in, but this device doesn’t have your workspace yet. Scan the code below with the device that has it.'
                  : 'You’re signed in, but this device doesn’t have your workspace yet. Connect a device that has it.'}
              </ConnSub>
              <ConnActions>
                {!pairNodeId && (
                  <Button onClick={() => setShowAddServer(true)}>
                    Connect a device
                  </Button>
                )}
              </ConnActions>
            </ConnBody>
          </LocalDriveNotice>
        )}

        {/* Cloud Vault first: it is what a managed account gets by default, and
            it is the promise we can make unconditionally — blind encrypted
            backup we cannot read. It hides itself entirely when we cannot
            determine its status, so a missing session never renders a dead
            button. */}

        {/* A local-only drive (demo, or any drive made offline) isn't synced.
            Offer to promote it to a normal synced drive on the connected
            server — the same reconcile a regular drive uses, no special path. */}
        {localOnlyDrive && !driveMissing && !showCloudBackup && (
          <LocalDriveNotice>
            <CardIcon $tone='provider'>
              <FaCloudArrowUp />
            </CardIcon>
            <ConnBody>
              <ConnTitle>Only on this device</ConnTitle>
              <ConnSub>
                This workspace hasn’t been synced. It’s safe here, but not
                backed up and not on your other devices.
              </ConnSub>
              <ConnActions>
                <Button
                  onClick={promoteDrive}
                  disabled={promoting || !status.serverConnected}
                >
                  {promoting ? 'Syncing…' : 'Sync this workspace'}
                </Button>
              </ConnActions>
              {!status.serverConnected && (
                <ConnMeta>Connect a device below first.</ConnMeta>
              )}
            </ConnBody>
          </LocalDriveNotice>
        )}

        <Section>
          <SectionTitle>Devices</SectionTitle>

          {/* Devices only. The hosted services moved up into the provider
              card, which is a narrower split than the one this list was
              built to avoid: that earlier layout scattered them as separate
              offer cards, where they are now one card under the account that
              pays for them. What is left here is an inventory of places this
              workspace physically lives. */}
          {/* This device — always the source of truth for local-first data. */}
          <DeviceCard>
            <CardIcon>
              <FaLaptop />
            </CardIcon>
            <ConnBody>
              <ConnTitle>This device</ConnTitle>
              <ConnSub>
                {isNode
                  ? status.lastDriveSync
                    ? `${status.lastDriveSync.count.toLocaleString()} resources · stored locally`
                    : 'Embedded server · stored locally'
                  : clientDbOn
                    ? 'Cached locally · works offline'
                    : 'Server-only · no local cache'}
              </ConnSub>
              {isNode && localNodeId && (
                <NodeIdRow>
                  <NodeIdLabel>Node ID</NodeIdLabel>
                  <NodeIdValue
                    title='Copy Node ID'
                    onClick={() => {
                      navigator.clipboard.writeText(localNodeId);
                      toast.success('Node ID copied');
                    }}
                  >
                    {localNodeId}
                  </NodeIdValue>
                </NodeIdRow>
              )}
            </ConnBody>
          </DeviceCard>

          {/* A client that cannot hold the provider's cookie — a self-hosted
              origin, or the desktop and Android apps on tauri://localhost — has
              to link before any of the vault works.

              Gated on whether this client has a session, not on what the vault
              says. The vault reports `unavailable` only once it has an agent, a
              drive and its wasm keys to ask with; a fresh install has none of
              those and sits at `loading` forever, so gating on the vault hid the
              one control that could have fixed it. */}
          {needsProviderLink && (
            <LinkProviderPanel
              portalUrl={getManagedPortalUrl(managedInfo)}
              onLinked={() => window.location.reload()}
            />
          )}

          {localOnlyDrive && connectionCount > 0 && (
            <ConnNote>
              These sync your other drives — not this workspace.
            </ConnNote>
          )}

          {/* About *other* devices specifically. This device and any cloud
              services are listed above, so the old "not syncing anywhere"
              wording now sat under entries proving otherwise. */}
          {connectionCount === 0 && connectionServers.length === 0 && (
            <EmptyConnections>
              <p>No other devices yet — your data is safe on this one.</p>
              <p>
                {isNode
                  ? 'Pair another device to sync directly, or connect an always-on one to reach your data from anywhere.'
                  : 'Connect an always-on device to back up your data and reach it from anywhere.'}
              </p>
            </EmptyConnections>
          )}

          {/* Servers we do not own — one stable list; the active one is marked,
              not moved. A managed node is deliberately absent: it moved up into
              the account card, because "what am I paying for" and "where does
              this drive live" are different questions and it was answering the
              second while looking like the first. */}
          {connectionServers
            .filter(server => !isManagedServer(server))
            .map(server => (
              <ServerCard
                key={server}
                server={server}
                status={status}
                managedInfo={managedInfo}
                serverStatus={nodes.server}
                hasWorkingLocalStore={hasWorkingLocalStore}
                nodeUsage={nodeUsage}
                quotaBytes={quotaBytes}
                serverNodeId={serverNodeId}
                onSwitch={switchToServer}
                onRemove={removeServer}
              />
            ))}

          {/* Paired devices (Iroh peers).

              Status comes from THIS device's own server rather than the local
              `atomic-peers` record: that record only updates when the user
              presses "Sync now", so it reported "synced 5 hours ago" about a
              link that was live and exchanging data. The server knows whether
              the peer is connected right now and when it last synced. */}
          {pairedPeers.map(peer => {
            const reported = serverPeers.find(
              p => nodeDidToRaw(p.nodeId) === nodeDidToRaw(peer.nodeId),
            );
            const lastSynced = reported?.lastSeen ?? peer.lastSync;

            return (
              <ConnCard key={peer.nodeId}>
                <CardIcon>
                  <FaMobileScreenButton />
                </CardIcon>
                <ConnBody>
                  <ConnTopRow>
                    <ConnTitle title={peer.nodeId}>{peer.label}</ConnTitle>
                    <ConnTopRight>
                      <StatusPill
                        $status={reported?.live ? 'synced' : 'unknown'}
                      >
                        {reported?.live ? 'Connected' : 'Paired'}
                      </StatusPill>
                      <NodeAction
                        onClick={() => syncWithPeer(peer.nodeId)}
                        disabled={peerSyncing}
                      >
                        {peerSyncing ? 'Syncing…' : 'Sync now'}
                      </NodeAction>
                    </ConnTopRight>
                  </ConnTopRow>
                  <ConnSub>
                    Paired device
                    {lastSynced
                      ? ` · synced ${formatTimeAgo(new Date(lastSynced)) ?? 'just now'}`
                      : ' · not synced yet'}
                    {/* Only what this side actually counted — the accepting node
                      answers frames through the engine and does not tally what
                      it served, and a fabricated 0 would be the same lie this
                      is meant to remove. */}
                    {reported?.lastSent !== undefined
                      ? ` · sent ${reported.lastSent}`
                      : ''}
                    {reported?.lastReceived !== undefined
                      ? ` · received ${reported.lastReceived}`
                      : ''}
                  </ConnSub>
                  <ConnActions>
                    <NodeActionSubtle onClick={() => removePeer(peer.nodeId)}>
                      Remove
                    </NodeActionSubtle>
                  </ConnActions>
                </ConnBody>
              </ConnCard>
            );
          })}

          {/* Devices paired with the server this browser reads from — a phone
              that scanned the code. The server reports them; this tab only
              shows them. */}
          {serverPeers.map(peer => {
            const raw = nodeDidToRaw(peer.nodeId);
            const name =
              peer.deviceName ?? (raw ? `${raw.slice(0, 12)}…` : peer.nodeId);

            return (
              <ConnCard key={peer.nodeId}>
                <CardIcon>
                  <FaMobileScreenButton />
                </CardIcon>
                <ConnBody>
                  <ConnTopRow>
                    <ConnTitle title={peer.nodeId}>{name}</ConnTitle>
                    <ConnTopRight>
                      <StatusPill $status={peer.live ? 'synced' : 'unknown'}>
                        {peer.live ? 'Connected' : 'Offline'}
                      </StatusPill>
                    </ConnTopRight>
                  </ConnTopRow>
                  <ConnSub>
                    Paired with {serverLabel(status.serverUrl ?? '')}
                    {/* "Connected" only says a socket is open. Say when data
                        last actually moved, so a link that is up but carrying
                        nothing is distinguishable from a healthy one. */}
                    {peer.lastSeen
                      ? ` · synced ${
                          formatTimeAgo(new Date(peer.lastSeen)) ?? 'just now'
                        }`
                      : ' · not synced yet'}
                    {/* What that sync actually moved. A timestamp alone cannot
                        tell a working link from one being refused every
                        subject. Deliberately the last pass, not a lifetime
                        total — see `KnownPeer::last_sent`. */}
                    {peer.lastSeen &&
                    (peer.lastSent !== undefined ||
                      peer.lastReceived !== undefined)
                      ? ` · sent ${peer.lastSent ?? 0}, received ${
                          peer.lastReceived ?? 0
                        }`
                      : ''}
                  </ConnSub>
                  <NodeIdRow>
                    <NodeIdLabel>Node ID</NodeIdLabel>
                    <NodeIdValue
                      title={`Copy ${peer.nodeId}`}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(peer.nodeId);
                          toast.success('Node ID copied');
                        } catch (e) {
                          store.notifyError(e as Error);
                        }
                      }}
                    >
                      {peer.nodeId}
                    </NodeIdValue>
                  </NodeIdRow>
                  <ConnActions>
                    <NodeActionSubtle
                      onClick={() => disconnectServerPeer(peer.nodeId)}
                    >
                      Disconnect
                    </NodeActionSubtle>
                  </ConnActions>
                </ConnBody>
              </ConnCard>
            );
          })}

          {peerSyncResult && (
            <PeerSyncResult $error={peerSyncResult.startsWith('Error')}>
              {peerSyncResult}
            </PeerSyncResult>
          )}

          {/* Add-a-server: inline (no dialog) — the same act as the switch
              cards above, so it lives in the same list. */}
          <AddRow>
            {showAddServer ? (
              <AddServerForm
                onSubmit={e => {
                  e.preventDefault();

                  if (!serverInput.trim()) {
                    return;
                  }

                  setServer(normalizeServerUrl(serverInput));
                  setServerInput('');
                  setShowAddServer(false);
                }}
              >
                <AddServerExplainer>
                  An always-on device has an address. One you carry has a code —
                  scan it below instead.
                </AddServerExplainer>
                <ServerInputRow>
                  <ServerInput
                    autoFocus
                    autoComplete='off'
                    placeholder='localhost:9883 or your-server.example'
                    value={serverInput}
                    onChange={e => setServerInput(e.target.value)}
                  />
                  <Button type='submit' disabled={!serverInput.trim()}>
                    Connect
                  </Button>
                  <NodeAction
                    type='button'
                    onClick={() => {
                      setShowAddServer(false);
                      setServerInput('');
                    }}
                  >
                    Cancel
                  </NodeAction>
                </ServerInputRow>
                <DocsLink
                  href='https://docs.atomicdata.dev/atomicserver/installation.html'
                  target='_blank'
                  rel='noopener'
                >
                  How to run your own server
                </DocsLink>
              </AddServerForm>
            ) : (
              <AddButton onClick={() => setShowAddServer(true)}>
                <FaPlus aria-hidden /> Connect a device
              </AddButton>
            )}
          </AddRow>
        </Section>

        {/* Pairing is the point of this page on a peer node, so it's shown
            outright rather than hidden behind a button: the code is routing
            only, and safe to leave on screen. */}
        {pairNodeId && (
          <Section>
            <SectionTitle>Sync a device</SectionTitle>
            {/* One line, not three: the card above already said what
                `localhost:9883` is, and a paragraph on how keys work belongs
                where someone asks — not over a QR they came here to scan. */}
            <ConnNote>
              {isNode
                ? 'Codes only route — your key still decides what syncs. Show yours, or take theirs.'
                : `Scan from your other device to sync with ${serverLabel(status.serverUrl ?? '')}. Safe to show: a code only routes.`}
            </ConnNote>
            <PairCard>
              <PairSide>
                {isNode && <PairLabel>Show this code</PairLabel>}
                <QrCentered>
                  <PairingCode nodeDid={rawToNodeDid(pairNodeId)} />
                </QrCentered>
              </PairSide>

              {/* Taking someone else's code needs a node to dial from, which a
                  browser tab is not. */}
              {isNode && (
                <>
                  <PairDivider aria-hidden />

                  <PairSide>
                    <PairLabel>
                      {isMobileTauri() ? 'Or scan theirs' : 'Or paste theirs'}
                    </PairLabel>
                    {/* Same path a scanned deep link takes (PairingLinkHandler):
                        validate, persist the peer, start a sync. */}
                    <ConnectToDeviceForm onCode={deliverDeepLink} />
                  </PairSide>
                </>
              )}
            </PairCard>
          </Section>
        )}

        {/* Developer: diagnostics + advanced toggles, tucked away. */}
        <DevDetails>
          <DevSummary>Developer</DevSummary>

          <DevGrid>
            {/* Node ID now lives on the server card / "This device" — it's
                node identity, not a developer detail. */}
            <DevRow>
              <DetailLabel>Local database</DetailLabel>
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
            </DevRow>
            <DevRow>
              <DetailLabel>WebSocket debug</DetailLabel>
              <DetailValue>
                <DebugToggle
                  type='checkbox'
                  checked={wsDebug}
                  onChange={e => {
                    setWsDebug(e.target.checked);
                    store.setWebSocketDebug(e.target.checked);
                  }}
                />
                {wsDebug ? 'Logging to console' : 'Off'}
              </DetailValue>
            </DevRow>
          </DevGrid>

          <DevActivityTitle>
            Recent activity
            {status.pendingDirtyCount > 0 && (
              <PendingCount>{status.pendingDirtyCount} unsynced</PendingCount>
            )}
          </DevActivityTitle>
          {commitLog.length > 0 ? (
            <LogList>
              {commitLog.map((entry, i) => (
                <CommitCard
                  key={`${entry.id}-${i}`}
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
                        {entry.propertySummaries.map((ps, j) => (
                          <PropertyRow
                            key={`${ps.property}-${j}`}
                            data-change-type={ps.changeType}
                          >
                            <span aria-hidden='true'>
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
        </DevDetails>
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
          type='checkbox'
          checked={enabled}
          onChange={e => onToggle(e.target.checked)}
          aria-label='Enable local WASM DB'
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

/**
 * The account strip under the lead line.
 *
 * Wears the same accent as an active connection card rather than a style of
 * its own: everything on this page that is backed by the provider account
 * reads blue, so a glance separates "this is yours and local" from "this
 * involves your account".
 */
const ProviderCard = styled.div`
  ${cardSurface}
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding: 0;
  margin-bottom: 2rem;
  border-color: ${p => p.theme.colors.main};
  background: ${p => `${p.theme.colors.main}0a`};
`;

const ProviderHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.9rem 1rem;
`;

/**
 * One service under the account header.
 *
 * Separated by a rule rather than by gaps between cards: these belong to the
 * account above them, and whitespace alone made them read as neighbours of it
 * instead of contents.
 */
const ProviderService = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 0.9rem;
  padding: 0.9rem 1rem;
  border-top: 1px solid ${p => `${p.theme.colors.main}33`};
  min-width: 0;

  /* A connection row is one ellipsised line because a server origin has no
     useful second line. These rows explain a service, so their text wraps —
     otherwise the recovery row trails off mid-sentence. */
  p,
  span {
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
  }
`;

const AccountBody = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
`;

const AccountLabel = styled.span`
  font-size: ${CARD_TITLE_FONT};
  font-weight: 600;
`;

const AccountEmail = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: ${CARD_SUB_FONT};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

  &:disabled {
    color: ${p => p.theme.colors.textLight};
    cursor: default;
    text-decoration: none;
  }
`;

/** Secondary / destructive actions (Remove). Muted so the card's primary
 *  action — the one beside the status pill — stays the obvious thing to click. */
const NodeActionSubtle = styled(NodeAction)`
  color: ${p => p.theme.colors.textLight};

  &:hover {
    color: ${p => p.theme.colors.alert};
  }
`;

const ManagedLink = styled.a`
  color: ${p => p.theme.colors.main};
  font-size: 0.8rem;
  text-decoration: none;
  margin-top: 0.15rem;

  &:hover {
    text-decoration: underline;
  }
`;

const Muted = styled.p`
  color: ${p => p.theme.colors.textLight};
`;

const statusColor = (status: NodeStatus, theme: DefaultTheme) => {
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

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const PendingCount = styled.span`
  font-size: 0.8rem;
  font-weight: 600;
  color: ${p => p.theme.colors.warning};
  margin-left: 0.5rem;
`;

// --- Connection cards ---

const cardBase = cardSurface;

/** The "This device" card. Same surface as the rest of the list — it is one
 *  of the devices, not a different kind of object. */
const DeviceCard = styled.div`
  ${cardBase}
  margin-bottom: 1.5rem;
`;

const NodeIdRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-top: 0.35rem;
  font-size: 0.75rem;
`;

const NodeIdLabel = styled.span`
  color: ${p => p.theme.colors.textLight};
  flex-shrink: 0;
`;

const NodeIdValue = styled.button`
  font-family: monospace;
  font-size: 0.75rem;
  color: ${p => p.theme.colors.text};
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;

  &:hover {
    color: ${p => p.theme.colors.main};
    text-decoration: underline;
  }
`;

/** `$active` marks the server actually in use. The list order is stable across
 *  switches, so this accent is the only thing that changes — which is the point:
 *  a reshuffling list is far harder to follow than a highlighted row. */
/**
 * Blue means "one of the provider's services", not "the one in use".
 *
 * These used to be the same thing, because the accent keyed off `$active`. A
 * self-hosted node someone runs on their own hardware is not a hosted product
 * no matter how live it is, and painting it the same blue as the account card
 * said it was. Being in use is still worth showing, so it keeps a neutral
 * emphasis, and the "In sync" badge next to the title carries the state.
 */
const ConnCard = styled.div<{ $active?: boolean; $provider?: boolean }>`
  ${cardBase}
  margin-bottom: 0.6rem;
  border-color: ${p =>
    p.$provider
      ? p.theme.colors.main
      : p.$active
        ? p.theme.colors.textLight
        : undefined};
  background: ${p => (p.$provider ? `${p.theme.colors.main}0a` : undefined)};
`;

/** A call to action, but still one of the cards in this list. The button
 *  inside it is the affordance; a second accent surface was just noise. */
const LocalDriveNotice = styled.div`
  ${cardBase}
  margin-bottom: 1.5rem;
`;

const ConnNote = styled.p`
  margin: 0 0 0.6rem;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.82rem;
`;

/** The two halves of pairing, side by side — one card, not two columns. */
const PairCard = styled.div`
  ${cardBase}
  align-items: stretch;
  gap: 1.5rem;

  /* Below this the two halves read better stacked; the divider turns with
     them. A container query would be truer, but the page has a single column
     whose width tracks the viewport. */
  @media (max-width: 40rem) {
    flex-direction: column;
    gap: 1.1rem;
  }
`;

const PairSide = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
`;

/** The QR is a fixed square; centre it rather than letting it hug the edge. */
const QrCentered = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
`;

const PairDivider = styled.div`
  flex-shrink: 0;
  align-self: stretch;
  width: 1px;
  background: ${p => p.theme.colors.bg2};

  @media (max-width: 40rem) {
    width: auto;
    height: 1px;
  }
`;

const PairLabel = styled.span`
  align-self: flex-start;
  font-size: 0.82rem;
  font-weight: 600;
  color: ${p => p.theme.colors.textLight};
`;

const ConnBody = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
`;

const ConnTopRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
`;

/** Status and the one thing you'd do about it, together: "Offline · Reconnect",
 *  "Not connected · Switch". The state and its remedy read as one unit rather
 *  than the action being stranded at the bottom of the card. */
const ConnTopRight = styled.div`
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-shrink: 0;
`;

const ConnTitle = styled.span`
  font-weight: 600;
  font-size: 0.95rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
`;

const ConnSub = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.82rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ConnMeta = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.8rem;
  margin-top: 0.3rem;
`;

const ConnError = styled.div`
  display: inline-flex;
  align-items: flex-start;
  gap: 0.35rem;
  margin-top: 0.3rem;
  color: ${p => p.theme.colors.alert};
  font-size: 0.8rem;
  line-height: 1.25;

  svg {
    flex-shrink: 0;
    margin-top: 0.12rem;
  }
`;

const ConnActions = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-top: 0.5rem;
  flex-wrap: wrap;
`;

/** A link, styled as one. The primary action next to it is the button. */
const LearnMore = styled.a`
  color: ${p => p.theme.colors.main};
  font-size: ${CARD_SUB_FONT};
  text-decoration: underline;

  &:hover,
  &:focus-visible {
    color: ${p => p.theme.colors.mainDark};
  }
`;

const StatusPill = styled.span<{ $status: NodeStatus }>`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: ${p => statusColor(p.$status, p.theme)};
  padding: 0.15rem 0.55rem;
  border-radius: 1rem;
  background: ${p => statusColor(p.$status, p.theme)}1c;

  svg {
    font-size: 0.65rem;
    ${p =>
      p.$status === 'syncing' &&
      css`
        animation: ${spin} 1s linear infinite;
      `}
  }
`;

const UsageBar = styled.div`
  margin-top: 0.5rem;
  height: 6px;
  border-radius: 3px;
  background: ${p => p.theme.colors.bg2};
  overflow: hidden;
`;

const UsageFill = styled.div`
  height: 100%;
  border-radius: 3px;
  background: ${p => p.theme.colors.main};
  transition: width 0.3s ease;
`;

const EmptyConnections = styled.div`
  padding: 1rem 1.1rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};
  margin-bottom: 0.8rem;

  p {
    margin: 0;
    color: ${p => p.theme.colors.textLight};
    font-size: 0.88rem;
  }

  p + p {
    margin-top: 0.4rem;
  }
`;

const AddRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin-top: 0.6rem;
`;

const AddButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  border: 1px dashed ${p => p.theme.colors.bg2};
  background: none;
  color: ${p => p.theme.colors.main};
  border-radius: ${p => p.theme.radius};
  padding: 0.5rem 0.9rem;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;

  svg {
    font-size: 0.7rem;
  }

  &:hover {
    border-color: ${p => p.theme.colors.main};
    background: ${p => p.theme.colors.main}0d;
  }
`;

const AddServerForm = styled.form`
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  width: 100%;
`;

const AddServerExplainer = styled.p`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.8rem;
  margin: 0;
`;

const ServerInputRow = styled.div`
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
`;

const ServerInput = styled.input`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 0.45rem 0.6rem;
  font-size: 0.85rem;
  background: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  flex: 1;
  min-width: 12rem;
`;

const DocsLink = styled.a`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
  display: inline-block;
`;

// --- Developer disclosure ---

const DevDetails = styled.details`
  margin-top: 2.5rem;
  border-top: 1px solid ${p => p.theme.colors.bg2};
  padding-top: 1rem;
`;

const DevSummary = styled.summary`
  cursor: pointer;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
  font-weight: 600;
  user-select: none;

  &:hover {
    color: ${p => p.theme.colors.text};
  }
`;

const DevGrid = styled.div`
  display: grid;
  gap: 0.4rem;
  margin-top: 1rem;
`;

const DevRow = styled.div`
  display: grid;
  grid-template-columns: 9rem minmax(0, 1fr);
  gap: 0.8rem;
  align-items: center;
  padding: 0.5rem 0.8rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};
  min-width: 0;
`;

const DevActivityTitle = styled.h3`
  font-size: 0.95rem;
  margin: 1.5rem 0 0.8rem;
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

const PeerSyncResult = styled.div<{ $error: boolean }>`
  font-size: 0.8rem;
  margin-top: 0.3rem;
  color: ${p => (p.$error ? p.theme.colors.warning : p.theme.colors.main)};
`;
