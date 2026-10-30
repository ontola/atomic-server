import { useState } from 'react';
import { canonicalizeScheme, useStore } from '@tomic/react';
import { styled } from 'styled-components';
import { DrivesCard, type DriveCardProps } from './DrivesCard';
import { DriveRow } from './DriveRow';
import { Button } from '../Button';
import { Row, Column } from '../Row';
import { Details } from '../Details';
import { ErrorLook } from '../ErrorLook';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  useDialog,
} from '../Dialog';
import { useDriveListManagement } from '../../hooks/useDriveListManagement';

export function DriveManager(props: DriveCardProps) {
  const { hidden, ready, setVisible } = useDriveListManagement();
  const store = useStore();
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dialog, showDialog, closeDialog] = useDialog();
  const selectable = props.drives.filter(
    s => canonicalizeScheme(s) !== canonicalizeScheme(props.privateDrive ?? ''),
  );
  const selection = selected.filter(s => selectable.includes(s));

  function askRemove(subjects: string[]) {
    setError(undefined);
    setRemoving(subjects);
    showDialog();
  }

  async function update(subjects: string[], visible: boolean) {
    setBusy(true);
    setError(undefined);
    await setVisible(subjects, visible)
      .then(() => {
        setSelected([]);
        closeDialog(true);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    setBusy(false);
  }

  function toggle(subject: string) {
    setSelected(previous =>
      previous.includes(subject)
        ? previous.filter(s => s !== subject)
        : [...previous, subject],
    );
  }

  return (
    <Column>
      <Toolbar>
        <Button
          subtle
          onClick={() => {
            setManaging(!managing);
            setSelected([]);
          }}
          disabled={busy}
        >
          {managing ? 'Done' : 'Manage drives'}
        </Button>
        {managing && (
          <>
            <Button
              subtle
              disabled={!ready || busy}
              onClick={() =>
                setSelected(
                  selection.length === selectable.length ? [] : selectable,
                )
              }
            >
              {selection.length === selectable.length && selectable.length > 0
                ? 'Deselect all'
                : 'Select all'}
            </Button>
            <Button
              disabled={!ready || busy || selection.length === 0}
              onClick={() => askRemove(selection)}
            >
              Remove selected ({selection.length})
            </Button>
          </>
        )}
      </Toolbar>
      {managing && (
        <p>
          Select drives to remove from your list. Their contents, sharing and
          cloud services stay unchanged.
        </p>
      )}
      <DrivesCard
        {...props}
        managing={managing}
        checked={selection}
        disabled={busy}
        onToggle={toggle}
        onDriveRemove={
          managing && ready ? subject => askRemove([subject]) : undefined
        }
        onDeleted={subject => {
          void setVisible([subject], false).catch(cause =>
            store.notifyError(cause),
          );
        }}
      />
      {error && !dialog.show && <ErrorLook>{error}</ErrorLook>}
      {hidden.length > 0 && (
        <Details title={`Removed from My drives (${hidden.length})`}>
          <Column>
            <p>You can add these drives back at any time.</p>
            {hidden.map(subject => (
              <DriveRow
                key={subject}
                subject={subject}
                label={props.labels?.[subject]}
                actions={
                  <Button
                    subtle
                    disabled={!ready || busy}
                    onClick={() => void update([subject], true)}
                  >
                    Restore
                  </Button>
                }
              />
            ))}
          </Column>
        </Details>
      )}
      <Dialog {...dialog} disableLightDismiss={busy}>
        <DialogTitle>
          <h1>Remove from My drives?</h1>
        </DialogTitle>
        <DialogContent>
          <p>
            Remove the selected drives from your list on devices that sync your
            private drive. This does not delete their contents, change access or
            cancel hosting and backup.
          </p>
          <p>You can undo this under Removed from My drives.</p>
          <Column gap='0' style={{ maxHeight: '35vh', overflow: 'auto' }}>
            {removing.map(subject => (
              <DriveRow
                key={subject}
                subject={subject}
                label={props.labels?.[subject]}
              />
            ))}
          </Column>
          {error && <ErrorLook>{error}</ErrorLook>}
        </DialogContent>
        <DialogActions>
          <Button subtle disabled={busy} onClick={() => closeDialog()}>
            Cancel
          </Button>
          <Button
            disabled={busy || !ready}
            loading={busy ? 'Removing…' : undefined}
            onClick={() => void update(removing, false)}
          >
            Remove from list
          </Button>
        </DialogActions>
      </Dialog>
    </Column>
  );
}

const Toolbar = styled(Row)`
  flex-wrap: wrap;
`;
