import { useState } from 'react';
import { styled } from 'styled-components';
import { FaRotateLeft, FaCloudArrowUp } from 'react-icons/fa6';
import { Button } from '../Button';
import { ServiceRow, type ServiceStanding } from '../Cloud/ServiceRow';
import { UsageMeter } from '../Cloud/UsageMeter';
import { VaultStorage } from './VaultStorage';
import { PRODUCT_NAME } from '../../helpers/managed/product';
import type { UseVaultBackup } from '../../helpers/managed/useVaultBackup';

/**
 * Cloud Vault for one drive, as one {@link ServiceRow}.
 *
 * Presentational: every decision lives in `useVaultBackup`, so this can be
 * dropped anywhere a drive is in view without dragging state with it.
 *
 * The copy is deliberate about which tier this is. Cloud Vault is *blind* —
 * encrypted backup we cannot read — while Cloud Server stores queryable state we
 * can. `OSS_STRATEGY.md` calls out that headlining "we can't read your data"
 * and then selling a tier that can is how a trust pitch gets lost, so the two
 * must never be described in the same words.
 */
export function VaultPanel({
  vault,
  onRestored,
  included = false,
}: {
  vault: UseVaultBackup;
  /** Called after a successful restore, so the host can refresh its view. */
  onRestored?: () => void;
  /** Cloud Server is on, so the vault is part of it rather than the plan. */
  included?: boolean;
}) {
  const { status, busy, error, restoreProgress } = vault;
  const [storageOpen, setStorageOpen] = useState(false);
  // What Cloud Vault is: the same sentence in every state. Declared in here,
  // not at module level, so the translation extractor sees it.
  const tagline = 'Encrypted backup of your data. Only you can read it.';
  const on = status.state === 'on';
  const standing: ServiceStanding | null = on
    ? included
      ? 'included'
      : 'current'
    : null;

  async function handleRestore() {
    const outcome = await vault.restore();

    if (outcome) onRestored?.();
  }

  // Still settling, or cannot say. Neither is "off": an enable button when we
  // could not even ask would turn a missing session into a confusing failure
  // on click. The row holds its place and says why.
  if (status.state === 'loading' || status.state === 'unavailable') {
    return (
      <ServiceRow
        data-testid='vault-panel'
        data-vault-state={status.state}
        kind='vault'
        title='Cloud Vault'
        tagline={tagline}
        status={{
          tone: 'muted',
          text:
            status.state === 'loading' ? (
              'Checking this workspace’s backup…'
            ) : (
              <span data-testid='vault-unavailable-reason'>
                {status.reason}
              </span>
            ),
        }}
      />
    );
  }

  if (status.state === 'off') {
    return (
      <ServiceRow
        data-testid='vault-panel'
        data-vault-state='off'
        kind='vault'
        title='Cloud Vault'
        tagline={tagline}
        points={[
          'Sealed on your device, so we cannot read it',
          'Restore this workspace on any device',
          'Free with an account',
        ]}
        status={
          error ? { tone: 'error', text: <ErrorText>{error}</ErrorText> } : null
        }
        actions={
          <Button
            data-testid='vault-enable'
            onClick={vault.enable}
            disabled={busy}
          >
            {busy ? 'Turning on…' : 'Turn on Cloud Vault'}
          </Button>
        }
      />
    );
  }

  const { enrollment, details } = status;
  const suspended = enrollment.status !== 'active';

  // The status line is the state: when it last went up. How much is stored
  // is the meter line, in the same place as Cloud Server's.
  const summary =
    details.confirmed_objects === 0
      ? `Nothing backed up to ${PRODUCT_NAME} yet`
      : enrollment.last_backup_at
        ? `Backed up ${formatWhen(enrollment.last_backup_at)}`
        : `Backed up to ${PRODUCT_NAME}`;
  const objects = `${details.confirmed_objects} object${
    details.confirmed_objects === 1 ? '' : 's'
  }`;

  // Included in Cloud Server, the vault's allowance is part of that plan, whose
  // own meter carries the limit. Quoting it here reads as the vault's limit.
  // Close to full it comes back, so a near-full vault is never hidden.
  const quota = enrollment.quota_bytes > 0 ? enrollment.quota_bytes : null;
  const nearlyFull = quota !== null && enrollment.used_bytes >= quota * 0.9;
  const showQuota = !included || nearlyFull;

  return (
    <>
      <ServiceRow
        data-testid='vault-panel'
        data-vault-state={suspended ? 'suspended' : 'on'}
        kind='vault'
        title='Cloud Vault'
        standing={standing}
        tagline={tagline}
        status={
          error
            ? { tone: 'error', text: <ErrorText>{error}</ErrorText> }
            : restoreProgress !== null
              ? {
                  tone: 'busy',
                  text: (
                    <span data-testid='vault-restore-progress'>
                      Restoring… {Math.round(restoreProgress * 100)}%
                    </span>
                  ),
                }
              : suspended
                ? {
                    tone: 'error',
                    text: (
                      <span data-testid='vault-suspended'>
                        Backups are paused. You can still restore what is
                        already stored.
                      </span>
                    ),
                  }
                : {
                    tone: 'ok',
                    text: (
                      // The object count is an attribute as well as prose: a
                      // test asserting that a second backup stored something
                      // should read the number, not parse a sentence.
                      <span
                        data-testid='vault-summary'
                        data-vault-objects={details.confirmed_objects}
                        data-vault-bytes={enrollment.used_bytes}
                      >
                        {summary}
                      </span>
                    ),
                  }
        }
        details={
          <>
            <UsageMeter
              data-testid='vault-usage'
              usedBytes={enrollment.used_bytes}
              quotaBytes={showQuota ? quota : null}
              backedUp
              facts={[objects]}
            />
            {!showQuota && (
              <IncludedNote data-testid='vault-included-note'>
                This backup is part of your Cloud Server plan.
              </IncludedNote>
            )}
            {storageOpen && (
              <VaultStorage
                drivePseudonym={enrollment.drive_pseudonym}
                onChanged={() => void vault.refresh()}
                onClose={() => setStorageOpen(false)}
              />
            )}
          </>
        }
        actions={
          <>
            <Button
              data-testid='vault-backup-now'
              onClick={vault.backupNow}
              disabled={busy || suspended}
            >
              <FaCloudArrowUp />{' '}
              <span>{busy ? 'Working…' : 'Back up now'}</span>
            </Button>
            <Button
              data-testid='vault-restore'
              subtle
              onClick={handleRestore}
              disabled={busy}
            >
              <FaRotateLeft /> <span>Restore</span>
            </Button>
            <Button
              data-testid='vault-manage-storage'
              subtle
              onClick={() => setStorageOpen(open => !open)}
              disabled={busy}
            >
              Manage storage
            </Button>
            <Button
              data-testid='vault-disable'
              subtle
              onClick={vault.disable}
              disabled={busy}
            >
              Turn off
            </Button>
          </>
        }
      />
    </>
  );
}

const IncludedNote = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85em;
`;

function ErrorText({ children }: { children: string }) {
  return <span data-testid='vault-error'>{children}</span>;
}

/** Unix seconds → a phrase, because an ISO timestamp answers a question nobody asked. */
function formatWhen(unixSeconds: number): string {
  const minutes = Math.floor((Date.now() / 1000 - unixSeconds) / 60);

  if (minutes < 1) return 'just now';

  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}
