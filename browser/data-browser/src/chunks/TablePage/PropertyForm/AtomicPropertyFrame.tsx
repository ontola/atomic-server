import { useEffect } from 'react';
import type { TablePropertyDialogPresentation } from '@tomic/table';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { Button } from '@components/Button';

export function AtomicPropertyFrame({
  title,
  children,
  actions,
  busy,
  canClose,
  onCancel,
  saveTestId,
  removeTestId,
}: TablePropertyDialogPresentation & {
  saveTestId?: string;
  removeTestId?: string;
}) {
  const [dialogProps, show] = useDialog();
  useEffect(() => {
    show();
  }, [show]);

  return (
    <Dialog {...dialogProps} onClose={onCancel} disableLightDismiss={!canClose}>
      <DialogTitle>
        <h1>{title}</h1>
      </DialogTitle>
      <DialogContent aria-busy={busy}>{children}</DialogContent>
      <DialogActions>
        {actions.map(action => (
          <Button
            key={action.key}
            data-testid={
              action.key === 'save'
                ? saveTestId
                : action.key === 'remove'
                  ? removeTestId
                  : undefined
            }
            subtle={action.key === 'cancel' || action.key === 'remove'}
            disabled={action.disabled}
            onClick={action.run}
          >
            {action.label}
          </Button>
        ))}
      </DialogActions>
    </Dialog>
  );
}
