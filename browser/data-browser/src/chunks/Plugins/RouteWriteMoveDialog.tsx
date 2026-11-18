import { Button } from '@components/Button';
import { Dialog, useDialog } from '@components/Dialog';
import { Column } from '@components/Row';
import type { JSONValue, RouteWriteConfigChange } from '@tomic/react';
import { useEffect, useState } from 'react';
import { RouteWriteApproval } from './RouteWriteApproval';

interface RouteWriteMoveDialogProps {
  plugin: string;
  /** The move to approve; the dialog opens while it is set. */
  change: RouteWriteConfigChange | undefined;
  config: JSONValue | undefined;
  /** Saves the config; `approve` says whether the moved targets were approved. */
  onSave: (approve: boolean) => Promise<void>;
  /** Called after the dialog closed, whether or not anything was saved. */
  onClose: () => void;
}

/**
 * Asks again for the route grant when a config change points a write target
 * somewhere else (#1758), the way an upgrade review asks for new targets:
 * the moved targets are marked New and nothing is approved by default.
 * Approving moves the plugin's write rights to the new parent; saving
 * unchecked drops the route grant and the rights it came with.
 */
export function RouteWriteMoveDialog({
  plugin,
  change,
  config,
  onSave,
  onClose,
}: RouteWriteMoveDialogProps) {
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogProps, show, hide] = useDialog({
    onCancel: onClose,
    onSuccess: onClose,
  });

  useEffect(() => {
    if (!change) return;
    setApprove(false);
    show();
  }, [change, show]);

  if (!change) return null;

  const save = async () => {
    setBusy(true);

    try {
      await onSave(approve);
      hide(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog {...dialogProps} width='700px'>
      <Dialog.Title>
        <h1>Move incoming items</h1>
      </Dialog.Title>
      <Dialog.Content>
        <Column>
          <p>
            This config stores what other servers send somewhere else. Approve
            the new place to move the plugin’s write rights there, or save
            without it to stop accepting these items.
          </p>
          <RouteWriteApproval
            plugin={plugin}
            targets={change.targets}
            newTargets={change.moved}
            config={config}
            checked={approve}
            onChange={setApprove}
          />
        </Column>
      </Dialog.Content>
      <Dialog.Actions>
        <Button onClick={() => hide(false)} subtle disabled={busy}>
          Cancel
        </Button>
        <Button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save config'}
        </Button>
      </Dialog.Actions>
    </Dialog>
  );
}
