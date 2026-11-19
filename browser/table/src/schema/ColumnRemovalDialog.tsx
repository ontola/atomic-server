import { Checkbox } from '@tomic/ui/components/forms/Checkbox';
import { TablePropertyDialogFrame } from './PropertyDialog.js';
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createTableDraftCommit } from './draftCommit.js';

export interface TableColumnRemovalDialogProps {
  /** Captured owner/property identity. A different scope starts a new intent. */
  scope: string;
  canRemove: boolean;
  canDeleteDefinition: boolean;
  children?: ReactNode;
  onConfirm: (deleteDefinition: boolean) => Promise<void>;
  onClose: () => void;
  messages?: Partial<{
    removeTitle: string;
    deleteTitle: string;
    deleteDefinition: string;
    remove: string;
    delete: string;
    cancel: string;
    pending: string;
    unavailable: string;
  }>;
}

/** Mount at page level, outside headers that schema changes can unmount.
 * Backend services own authorization, captured identity and write confirmation.
 * A failed write retains the intent; closing never cancels an in-flight write. */
export function TableColumnRemovalDialog(props: TableColumnRemovalDialogProps) {
  return <RemovalIntent key={props.scope} {...props} />;
}

function RemovalIntent({
  scope,
  canRemove,
  canDeleteDefinition,
  children,
  onConfirm,
  onClose,
  messages,
}: TableColumnRemovalDialogProps) {
  const controller = useMemo(() => createTableDraftCommit(scope), [scope]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [deleteDefinition, setDeleteDefinition] = useState(false);
  const text = {
    removeTitle: 'Remove column',
    deleteTitle: 'Delete property',
    deleteDefinition: 'Delete property and its children',
    remove: 'Remove',
    delete: 'Delete',
    cancel: 'Cancel',
    pending: 'Removing column…',
    unavailable:
      'Column removal is unavailable. Check access and the selected table.',
    ...messages,
  };
  const valid = canRemove && (!deleteDefinition || canDeleteDefinition);
  useEffect(() => () => controller.invalidate(), [controller]);

  const cancel = () => {
    if (!controller.getSnapshot().busy) onClose();
  };

  const confirm = async () => {
    const result = await controller.run(
      () => onConfirm(deleteDefinition),
      valid,
    );

    if (result.status === 'saved') onClose();
  };

  return (
    <TablePropertyDialogFrame
      title={deleteDefinition ? text.deleteTitle : text.removeTitle}
      busy={state.busy}
      canClose={!state.busy}
      onCancel={cancel}
      actions={[
        {
          key: 'cancel',
          label: text.cancel,
          disabled: state.busy,
          run: cancel,
        },
        {
          key: 'remove',
          label: deleteDefinition ? text.delete : text.remove,
          disabled: state.busy || !valid,
          run: () => {
            void confirm();
          },
        },
      ]}
    >
      {children}
      <label style={{ display: 'flex', gap: '0.5rem', marginBlock: '1rem' }}>
        <Checkbox
          checked={deleteDefinition}
          disabled={state.busy || (!canDeleteDefinition && !deleteDefinition)}
          onChange={checked => {
            if (controller.getSnapshot().busy) return;
            if (checked && !canDeleteDefinition) return;
            setDeleteDefinition(checked);
            controller.clearError();
          }}
        />
        {text.deleteDefinition}
      </label>
      {!valid && <p role='alert'>{text.unavailable}</p>}
      {state.error && <p role='alert'>{state.error.message}</p>}
      {state.busy && <p role='status'>{text.pending}</p>}
    </TablePropertyDialogFrame>
  );
}
