import { useEffect, useSyncExternalStore } from 'react';
import { useLocation } from '@tanstack/react-router';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';
import { useStore } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { deviceHasDriveData } from '../helpers/driveData';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';
import { CLOUD_SERVER_PRICE } from '../helpers/cloudServerPrice';
import { paths } from '../routes/paths';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { Button } from './Button';
import { ToastBody } from './Notifications/toastStyles';
import {
  AUTO_BACKUP_RETRY_MS,
  ensureVaultBackup,
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
  const { agent, drive } = useSettings();
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

  useEffect(() => watchForVaultBackups(store), [store]);

  useEffect(() => {
    if (!firstBackupStatus || onSignupScreen) return;

    const id = toast.custom(
      <VaultNoticeToast data-testid='vault-first-backup-status'>
        <ToastBody role='status'>
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
                    `${paths.sync}?${new URLSearchParams({ drive: fullDrive })}`,
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

const VaultNoticeToast = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.6rem;
  max-width: 22rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid ${p => p.theme.colors.alert};
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
