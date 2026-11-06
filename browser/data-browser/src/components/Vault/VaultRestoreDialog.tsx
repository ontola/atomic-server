import { useState } from 'react';
import {
  ConfirmationDialog,
  ConfirmationDialogTheme,
} from '../ConfirmationDialog';
import { RadioGroup, RadioInput } from '../forms/RadioInput';
import type { VaultSnapshotUsage } from '../../helpers/managed/vault';

function formatSnapshotTime(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Pick the snapshot to restore the drive to, and confirm it.
 *
 * Restoring overwrites the drive with its state at that moment, so the one
 * thing this has to make unmistakable is what is lost: everything after it.
 * With a single snapshot there is nothing to pick, only the confirmation.
 */
export function VaultRestoreDialog({
  snapshots,
  onRestore,
  onClose,
}: {
  /** Newest first. The newest is preselected. */
  snapshots: VaultSnapshotUsage[];
  onRestore: (snapshotId: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(snapshots[0].id);
  const chosen = snapshots.find(s => s.id === selected) ?? snapshots[0];
  const when = formatSnapshotTime(chosen.created_at);

  return (
    <ConfirmationDialog
      show
      bindShow={open => {
        if (!open) onClose();
      }}
      title={
        snapshots.length > 1 ? 'Restore a snapshot' : 'Restore this backup?'
      }
      confirmLabel='Restore'
      theme={ConfirmationDialogTheme.Alert}
      onConfirm={() => onRestore(chosen.id)}
    >
      {snapshots.length > 1 && (
        <RadioGroup role='radiogroup' aria-label='Snapshot'>
          {snapshots.map(snap => (
            <RadioInput
              key={snap.id}
              name='vault-snapshot'
              data-testid={`vault-restore-snapshot-${snap.id}`}
              checked={snap.id === chosen.id}
              onChange={() => setSelected(snap.id)}
            >
              {formatSnapshotTime(snap.created_at)}
            </RadioInput>
          ))}
        </RadioGroup>
      )}
      <p data-testid='vault-restore-warning'>
        {`Your drive will go back to how it was on ${when}. Changes made after that moment will be lost for everyone who uses this drive.`}
      </p>
      <p>
        Items added since are moved to the Trash, and the restore is saved as a
        new change, so each item’s History still has what it replaced.
      </p>
    </ConfirmationDialog>
  );
}
