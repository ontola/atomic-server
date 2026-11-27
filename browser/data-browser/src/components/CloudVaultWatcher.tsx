import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation } from '@tanstack/react-router';
import { FaTriangleExclamation } from 'react-icons/fa6';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';
import { StoreEvents, type Store, useStore, withDeadline } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { deviceHasDriveData } from '../helpers/driveData';
import {
  getDriveProtectionWarning,
  readDriveProtection,
  type DriveProtectionWarning,
} from '../helpers/driveProtection';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';
import { CLOUD_SERVER_PRICE } from '../helpers/cloudServerPrice';
import { paths } from '../routes/paths';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { Button } from '@tomic/ui/components/Button';
import { ToastBody } from './Notifications/toastStyles';
import {
  AUTO_BACKUP_RETRY_MS,
  ensureVaultBackup,
  onVaultChanged,
  onVaultFull,
  watchForVaultBackups,
} from '../helpers/managed/vaultAutoBackup';
import {
  getFirstVaultBackupStatus,
  subscribeFirstVaultBackupStatus,
} from '../helpers/managed/vaultFirstBackupStatus';

/**
 * Keeps the signed-in account's personal drive backed up in Cloud Vault while
 * the app is open, and shows when a new workspace has no confirmed backup.
 *
 * Two jobs. At boot, and whenever the agent changes, it enrols the personal
 * drive and backs it up once — which is how an account that predates automatic
 * backup, or that only ever signs in on this device, gets covered without
 * going through sign-in again. After that it backs the open drive up again a
 * while after each edit. Periodic retries cover late account linking and data
 * arriving after startup. Both paths require an eligible account session.
 */
export function CloudVaultWatcher() {
  const store = useStore();
  const { agent, baseURL, drive } = useSettings();
  const subject = agent?.subject;
  const navigate = useNavigateWithTransition();
  const { pathname } = useLocation();
  const onSignupScreen =
    pathname === paths.welcome ||
    pathname === paths.onboarding ||
    pathname.startsWith(`${paths.onboarding}/`);
  const firstBackupStatus = useSyncExternalStore(
    subscribeFirstVaultBackupStatus,
    () => (subject && drive ? getFirstVaultBackupStatus(subject, drive) : null),
  );
  const warning = useDriveProtectionWarning(
    store,
    subject,
    onSignupScreen || firstBackupStatus ? '' : drive,
    baseURL,
  );
  const severity = warning?.severity;
  const warningMessage = warning ? driveProtectionMessage(warning) : null;

  useEffect(() => watchForVaultBackups(store), [store]);

  useEffect(() => {
    if (!firstBackupStatus || onSignupScreen) return;

    const id = toast.custom(
      <VaultNoticeToast data-testid='vault-first-backup-status'>
        <ToastBody role={firstBackupStatus === 'failed' ? 'alert' : 'status'}>
          <VaultNoticeTitle>
            {firstBackupStatus === 'failed'
              ? 'The first Cloud Vault backup failed.'
              : 'Cloud Vault hasn’t completed the first backup yet.'}
          </VaultNoticeTitle>
          <span>This workspace has no confirmed Cloud Vault copy.</span>
        </ToastBody>
        <Button
          onClick={() => {
            if (store.getAgent()?.subject === subject) {
              void ensureVaultBackup(store, drive);
            }
          }}
        >
          Retry backup
        </Button>
      </VaultNoticeToast>,
      { id: `vault-first-backup:${drive}`, duration: Infinity },
    );

    return () => toast.remove(id);
  }, [drive, firstBackupStatus, onSignupScreen, store, subject]);

  useEffect(() => {
    if (!severity || !warningMessage) return;

    const id = toast.custom(
      <VaultNoticeToast
        $medium={severity === 'medium'}
        data-testid='vault-no-backup-status'
        data-severity={severity}
      >
        <ToastBody role={severity === 'hard' ? 'alert' : 'status'}>
          <ProtectionTitle $medium={severity === 'medium'}>
            <FaTriangleExclamation aria-hidden />
            {warningMessage}
          </ProtectionTitle>
        </ToastBody>
        <Button
          onClick={() =>
            void navigate(`${paths.sync}?${new URLSearchParams({ drive })}`)
          }
        >
          Open sync settings
        </Button>
      </VaultNoticeToast>,
      { id: `drive-protection:${drive}`, duration: Infinity },
    );

    return () => toast.remove(id);
  }, [drive, navigate, severity, warningMessage]);

  // A full vault is an upsell moment, not an error: no Bugsnag, and a button
  // that goes to the plans for that drive.
  useEffect(
    () =>
      onVaultFull(fullDrive => {
        toast.custom(
          t => (
            <VaultNoticeToast role='alert'>
              <ToastBody>
                <VaultNoticeTitle>
                  Cloud Vault is full, so this drive is not being backed up.
                </VaultNoticeTitle>
              </ToastBody>
              <UpgradeButton
                onClick={() => {
                  toast.dismiss(t.id);
                  void navigate(
                    `${paths.sync}&${new URLSearchParams({ drive: fullDrive })}`,
                  );
                }}
              >
                Upgrade to Cloud Server from {CLOUD_SERVER_PRICE}
              </UpgradeButton>
              <Button subtle onClick={() => toast.dismiss(t.id)}>
                Not now
              </Button>
            </VaultNoticeToast>
          ),
          { id: `vault-full:${fullDrive}`, duration: Infinity },
        );
      }),
    [navigate],
  );

  useEffect(() => {
    const currentAgent = store.getAgent();

    if (!subject || currentAgent?.subject !== subject) return;

    let cancelled = false;

    let checking = false;

    const check = () => {
      if (checking || cancelled) return;
      checking = true;

      void fetchPrivateDriveSubject(store, currentAgent)
        .catch(() => undefined)
        .then(async privateDrive => {
          if (cancelled || !privateDrive) return;

          // Sign-in restores the drive on devices that don't have it yet.
          if (!(await deviceHasDriveData(store, privateDrive))) return;

          if (!cancelled) await ensureVaultBackup(store, privateDrive);
        })
        .finally(() => {
          checking = false;
        });
    };

    check();
    // Account linking, restored data and connectivity can arrive after mount.
    const retry = setInterval(check, AUTO_BACKUP_RETRY_MS);
    window.addEventListener('online', check);

    return () => {
      cancelled = true;
      clearInterval(retry);
      window.removeEventListener('online', check);
    };
  }, [store, subject]);

  return null;
}

function driveProtectionMessage({
  age,
  missingCopy,
  source,
}: DriveProtectionWarning): string {
  if (missingCopy)
    return 'No copy of this drive could be verified in Cloud Vault or on an external server.';

  if (source === 'server') {
    if (age === 'day-old')
      return 'The last verified full sync with the server was more than 24 hours ago.';
    if (age === 'week-old')
      return 'The last verified full sync with the server was at least 7 days ago.';

    return 'A full sync with the server could not be verified.';
  }

  if (age === 'day-old')
    return 'The latest verified backup is more than 24 hours old.';
  if (age === 'week-old')
    return 'The latest verified backup is at least 7 days old.';

  return 'No backup from the last 7 days could be verified.';
}

function useDriveProtectionWarning(
  store: Store,
  agentSubject: string | undefined,
  drive: string,
  server: string,
) {
  const [state, setState] = useState<{
    agentSubject: string;
    drive: string;
    server: string;
    warning: ReturnType<typeof getDriveProtectionWarning>;
  } | null>(null);

  useEffect(() => {
    const agent = store.getAgent();

    if (!drive || !agent?.subject || agent.subject !== agentSubject) return;
    const subject = agent.subject;

    let cancelled = false;
    let checking = false;
    let recheck = false;
    let lastSync: number | undefined;
    let serverReady = false;

    const updateWarning = async () => {
      if (!(await withDeadline(deviceHasDriveData(store, drive), 8_000, false)))
        return;
      if (cancelled) return;

      const evidence = await withDeadline(
        readDriveProtection(store, drive, agent, server),
        10_000,
        {
          vaultHasCopy: false,
          lastBackupAt: null,
          serverHasCopy: false,
          lastFullSyncAt: null,
        },
      );

      if (cancelled || store.getAgent()?.subject !== subject) return;
      setState({
        agentSubject: subject,
        drive,
        server,
        warning: getDriveProtectionWarning(evidence, Date.now()),
      });
    };

    function check() {
      if (cancelled || store.getAgent()?.subject !== subject) return;

      if (checking) {
        recheck = true;

        return;
      }

      checking = true;
      void updateWarning().finally(() => {
        checking = false;

        if (recheck) {
          recheck = false;
          check();
        }
      });
    }

    check();
    const poll = setInterval(check, AUTO_BACKUP_RETRY_MS);
    const offVault = onVaultChanged(changed => {
      if (changed === drive) check();
    });
    const offSync = store.on(StoreEvents.SyncStatusChanged, status => {
      const sync = status.lastDriveSync;
      const ready =
        status.drive === drive &&
        status.serverConnected &&
        !status.syncInProgress &&
        status.pendingDirtyCount === 0 &&
        status.blockedCount === 0;
      const settled = ready && !serverReady;
      serverReady = ready;

      if (sync?.drive === drive && sync.timestamp !== lastSync) {
        lastSync = sync.timestamp;
        check();
      } else if (settled) {
        check();
      }
    });
    window.addEventListener('focus', check);
    window.addEventListener('online', check);

    return () => {
      cancelled = true;
      clearInterval(poll);
      offVault();
      offSync();
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
    };
  }, [agentSubject, drive, server, store]);

  return state?.agentSubject === agentSubject &&
    state?.drive === drive &&
    state.server === server
    ? state.warning
    : null;
}

const VaultNoticeToast = styled.div<{ $medium?: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.6rem;
  max-width: 22rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid
    ${p => (p.$medium ? p.theme.colors.warning : p.theme.colors.alert)};
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg};
  box-shadow: ${p => p.theme.boxShadowSoft};
  color: ${p => p.theme.colors.text};
`;

const UpgradeButton = styled(Button)`
  max-width: 100%;
  white-space: normal;
  text-align: start;
`;

/** Unlike a chat toast title, this sentence must wrap, not be cut off. */
const VaultNoticeTitle = styled.span`
  font-weight: 600;
  font-size: 0.85rem;
`;

const ProtectionTitle = styled(VaultNoticeTitle)<{ $medium: boolean }>`
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;

  svg {
    color: ${p => (p.$medium ? p.theme.colors.warning : p.theme.colors.alert)};
    flex: none;
    margin-top: 0.15em;
  }
`;
