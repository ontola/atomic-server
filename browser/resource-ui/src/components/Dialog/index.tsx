import { type PropsWithChildren } from 'react';
import {
  Dialog as SharedDialog,
  type InternalDialogProps,
} from '@tomic/ui/components/Dialog/index';
import { useOptionalResourceUIHost } from '../../ResourceUIHost.js';

export * from '@tomic/ui/components/Dialog/index';
export function Dialog(props: PropsWithChildren<InternalDialogProps>) {
  const feedback = useOptionalResourceUIHost()?.feedback;

  return <SharedDialog {...props} feedback={feedback} />;
}

Dialog.Title = SharedDialog.Title;
Dialog.Content = SharedDialog.Content;
Dialog.Actions = SharedDialog.Actions;
