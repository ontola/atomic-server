import { lazy, Suspense, type PropsWithChildren } from 'react';
import {
  Dialog as SharedDialog,
  type InternalDialogProps,
} from '@tomic/ui/components/Dialog/index';
import { useRootWelcomeLayout } from '../../context/RootWelcomeLayoutContext';

export * from '@tomic/ui/components/Dialog/index';
const FeedbackButton = lazy(() =>
  import('../SideBar/FeedbackButton').then(module => ({
    default: module.FeedbackButton,
  })),
);

/** Keep welcome-screen feedback in the Atomic shell. */
export function Dialog(props: PropsWithChildren<InternalDialogProps>) {
  const { rootWelcomeChromeHidden } = useRootWelcomeLayout();

  return (
    <SharedDialog
      {...props}
      feedback={
        rootWelcomeChromeHidden ? (
          <Suspense fallback={null}>
            <FeedbackButton />
          </Suspense>
        ) : undefined
      }
    />
  );
}

Dialog.Title = SharedDialog.Title;
Dialog.Content = SharedDialog.Content;
Dialog.Actions = SharedDialog.Actions;
