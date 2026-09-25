import { useEffect, useRef, type JSX } from 'react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { Button } from '@components/Button';
import { RowGrantText } from '@chunks/AppPage/RowGrantText';

/**
 * The confirmation shown when someone makes an app a view of a table (#1740):
 * from "+ Add view", from a tab's "View type" list, or from the tab's menu.
 *
 * Choosing the app is not consent to it writing: the view can be added
 * read-only, and the app can ask later. `readOnlyLabel` is left out where
 * there is nothing to add read-only (the tab already shows the app).
 */
export function RowGrantDialog({
  appName,
  show,
  bindShow,
  onChoose,
  readOnlyLabel,
}: {
  appName: string;
  show: boolean;
  bindShow: (show: boolean) => void;
  /** `true` to add with a grant, `false` to add read-only. */
  onChoose: (allowEditing: boolean) => void;
  readOnlyLabel?: string;
}): JSX.Element {
  // Which button closed it. `useDialog` reports only success or not.
  const choice = useRef<boolean | undefined>(undefined);
  const [dialogProps, showDialog, hideDialog] = useDialog({
    bindShow,
    onSuccess: () => {
      if (choice.current !== undefined) onChoose(choice.current);
    },
  });

  useEffect(() => {
    if (show) {
      choice.current = undefined;
      showDialog();
    }
  }, [show]);

  if (!show) return <></>;

  const choose = (allowEditing: boolean) => {
    choice.current = allowEditing;
    hideDialog(true);
  };

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h1>Let {appName} edit rows?</h1>
      </DialogTitle>
      <DialogContent>
        <p>
          <RowGrantText appName={appName} />
        </p>
      </DialogContent>
      <DialogActions>
        {/* Where it can be added read-only, the dialog's close button is
         *  the cancel: three buttons do not fit a phone's width. */}
        {!readOnlyLabel && (
          <Button onClick={() => hideDialog(false)} subtle>
            Cancel
          </Button>
        )}
        {readOnlyLabel && (
          <Button onClick={() => choose(false)} subtle>
            {readOnlyLabel}
          </Button>
        )}
        <Button onClick={() => choose(true)}>Allow editing</Button>
      </DialogActions>
    </Dialog>
  );
}
