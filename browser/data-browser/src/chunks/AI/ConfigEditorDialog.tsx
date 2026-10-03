import { useEffect, type ReactNode } from 'react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { Button } from '@components/Button';

interface ConfigEditorDialogProps {
  /** Opens the dialog when true. Stays true until `onClosed` runs. */
  open: boolean;
  title: string;
  saveLabel: string;
  canSave: boolean;
  /** Persists the edited item. The dialog closes afterwards. */
  onSave: () => void;
  /** Runs once the dialog has fully closed, after a save or a cancel. */
  onClosed: () => void;
  children: ReactNode;
}

/**
 * Dialog used to create or edit an agent, skill or MCP server from the AI
 * settings. The list stays on the settings page; the form lives in here.
 */
export function ConfigEditorDialog({
  open,
  title,
  saveLabel,
  canSave,
  onSave,
  onClosed,
  children,
}: ConfigEditorDialogProps) {
  const [dialogProps, showDialog, hideDialog, dialogVisible] = useDialog({
    onCancel: onClosed,
    onSuccess: onClosed,
  });

  useEffect(() => {
    if (open) {
      showDialog();
    } else {
      hideDialog();
    }
  }, [open, showDialog, hideDialog]);

  const handleSave = () => {
    if (!canSave) return;

    onSave();
    hideDialog(true);
  };

  return (
    <Dialog {...dialogProps} width='70ch'>
      {dialogVisible && (
        <>
          <DialogTitle>
            <h1>{title}</h1>
          </DialogTitle>
          <DialogContent>{children}</DialogContent>
          <DialogActions>
            <Button subtle onClick={() => hideDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!canSave}>
              {saveLabel}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}
