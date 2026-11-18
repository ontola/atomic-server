import { useEffect } from 'react';
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

/**
 * Keeps the signed-in account's personal drive backed up in Cloud Vault while
 * the app is open. Renders nothing.
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
  const { agent } = useSettings();
  const subject = agent?.subject;
  const navigate = useNavigateWithTransition();

  useEffect(() => watchForVaultBackups(store), [store]);

  // A full vault is an upsell moment, not an error: no Bugsnag, and a button
  // that goes to the plans for that drive.
  useEffect(
    () =>
      onVaultFull(drive => {
        toast.custom(
          t => (
            <VaultFullToast role='alert'>
              <ToastBody>
                <VaultFullText>
                  Cloud Vault is full, so this drive is not being backed up.
                </VaultFullText>
              </ToastBody>
              <UpgradeButton
                onClick={() => {
                  toast.dismiss(t.id);
                  void navigate(
                    `${paths.sync}?${new URLSearchParams({ drive })}`,
                  );
                }}
              >
                Upgrade to Cloud Server from {CLOUD_SERVER_PRICE}
              </UpgradeButton>
              <Button subtle onClick={() => toast.dismiss(t.id)}>
                Not now
              </Button>
            </VaultFullToast>
          ),
          { id: `vault-full:${drive}`, duration: Infinity },
        );
      }),
    [navigate],
  );

  useEffect(() => {
    if (!subject || !agent) return;

    let cancelled = false;

    let checking = false;

    const check = async () => {
      if (checking || cancelled) return;
      checking = true;

      try {
        const drive = await fetchPrivateDriveSubject(store, agent).catch(
          () => undefined,
        );

        if (cancelled || !drive) return;

        // Nothing to back up from a device that does not hold the drive — and
        // sign-in handles that device by restoring instead.
        if (!(await deviceHasDriveData(store, drive))) return;

        if (!cancelled) await ensureVaultBackup(store, drive);
      } finally {
        checking = false;
      }
    };

    void check();
    // Account linking, restored data and connectivity can arrive after mount.
    const retry = setInterval(() => void check(), AUTO_BACKUP_RETRY_MS);
    const onOnline = () => void check();
    window.addEventListener('online', onOnline);

    return () => {
      cancelled = true;
      clearInterval(retry);
      window.removeEventListener('online', onOnline);
    };
    // `agent` is a new object on every settings render; its subject is what
    // identifies a sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, subject]);

  return null;
}

const VaultFullToast = styled.div`
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
const VaultFullText = styled.span`
  font-weight: 600;
  font-size: 0.85rem;
`;
