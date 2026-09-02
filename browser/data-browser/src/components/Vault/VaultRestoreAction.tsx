import { useStore } from '@tomic/react';
import { FaRotateLeft } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { Button } from '../Button';
import { useDriveVault } from '../../helpers/managed/useDriveVault';
import { isOriginWithoutNode } from '../../helpers/originNode';

import type { JSX } from 'react';

/**
 * "Restore from Cloud Vault", for a drive this device cannot open.
 *
 * Rendered on the error page, because that is where a second browser lands
 * when it is sent to a drive it has never held: "Could not open did:ad:… —
 * resource not available locally". The connect-device step makes the same
 * offer at sign-in, but not everyone arrives through sign-in — a bookmark, a
 * shared link, or a session that outlived its data all end up here instead.
 *
 * Shows nothing unless the vault holds a backup of exactly this drive, so on a
 * self-hosted server or for a subject that is not a backed-up drive the page
 * is unchanged.
 */
export function VaultRestoreAction({
  subject,
}: {
  subject: string;
}): JSX.Element | null {
  const store = useStore();
  const vault = useDriveVault(subject);

  const canRestore =
    vault.status.state === 'on' && vault.status.details.confirmed_objects > 0;

  if (!canRestore) return null;

  async function restore() {
    const outcome = await vault.restore();

    if (!outcome) return;

    // On an origin with no node the restored drive lives only here, like one
    // made here; without this every commit would park in the outbox.
    if (isOriginWithoutNode(store.getServerUrl())) {
      store.registerLocalOnlyDrive(subject);
    }

    // The failed fetch that brought us here is cached; ask again now that the
    // drive is in local storage.
    await store.fetchResourceFromServer(subject, { setLoading: true });
  }

  return (
    <Offer data-testid='vault-restore-offer'>
      <p>This workspace has an encrypted backup in Cloud Vault.</p>
      {vault.error && <ErrorText role='alert'>{vault.error}</ErrorText>}
      {vault.restoreProgress !== null && (
        <p>Restoring… {Math.round(vault.restoreProgress * 100)}%</p>
      )}
      <Button
        data-testid='vault-restore-now'
        onClick={restore}
        disabled={vault.busy}
      >
        <FaRotateLeft />{' '}
        {vault.busy ? 'Restoring…' : 'Restore from Cloud Vault'}
      </Button>
    </Offer>
  );
}

const Offer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
`;

const ErrorText = styled.p`
  color: ${p => p.theme.colors.alert};
  margin: 0;
`;
