import toast, {
  type Toast,
  ToastBar,
  Toaster as ReactHotToast,
  resolveValue,
  type Renderable,
} from 'react-hot-toast';
import { FaComment, FaCopy, FaXmark } from 'react-icons/fa6';
import styled, { useTheme } from 'styled-components';
import { zIndex } from '../styling';
import { Column, Row } from './Row';
import { IconButton } from './IconButton/IconButton';
import { Button } from './Button';
import { useSettings } from '../helpers/AppSettings';
import { shortenSubjects } from '../helpers/shortenSubjects';
import {
  ERROR_TOAST_DURATION,
  reportableErrorForToast,
} from '../handlers/reportableErrors';

import { lazy, Suspense, useRef, useState, type JSX } from 'react';

const ErrorReportDialog = lazy(() =>
  import('./SideBar/FeedbackButton').then(module => ({
    default: module.ErrorReportDialog,
  })),
);

/**
 * Makes themed toast notifications available in the Context. Render this
 * somewhere high up in the app, inside the DialogGlobalContextProvider: error
 * toasts open the report dialog.
 */
export function Toaster(): JSX.Element {
  const theme = useTheme();
  const { navbarTop } = useSettings();
  const [reportError, setReportError] = useState<Error>();

  return (
    <>
      <ReactHotToast
        position='bottom-right'
        // Toasts stack up from the bottom right, which is where the navbar is
        // when it sits at the bottom: they covered the search button and the
        // context menu. Lift the whole container by the navbar's height so a
        // toast never blocks a button you need to reach.
        containerStyle={
          navbarTop
            ? undefined
            : { bottom: `calc(${theme.heights.breadCrumbBar} + 1rem)` }
        }
        toastOptions={{
          style: {
            zIndex: zIndex.toast,
            background: theme.colors.bg,
            color: theme.colors.text,
            wordBreak: 'break-word',
          },
          error: { duration: ERROR_TOAST_DURATION },
        }}
      >
        {t => (
          <ToastBar
            toast={t}
            style={{
              ...t.style,
              border: `solid 1px ${theme.colors.bg2}`,
              position: 'relative',
              animation: t.visible
                ? 'toast-enter .2s ease-out'
                : 'toast-exit 1s ease-in',
            }}
          >
            {({ icon, message }) => (
              <ToastMessage
                icon={icon}
                message={message}
                t={t}
                onReport={setReportError}
              />
            )}
          </ToastBar>
        )}
      </ReactHotToast>
      {reportError && (
        <Suspense fallback={null}>
          <ErrorReportDialog
            error={reportError}
            onClosed={() => setReportError(undefined)}
          />
        </Suspense>
      )}
    </>
  );
}

interface ToastMessageProps {
  icon: React.ReactNode;
  message: Renderable;
  t: Toast;
  onReport: (error: Error) => void;
}

function ToastMessage({ icon, message, t, onReport }: ToastMessageProps) {
  const textRef = useRef<HTMLDivElement>(null);
  const reportable =
    t.type === 'error' ? reportableErrorForToast(t.id) : undefined;

  const resolved = resolveValue(message, t);
  // Long subject URLs are cut for display; copying still gives the full text.
  const fullText = typeof resolved === 'string' ? resolved : undefined;

  function handleCopy() {
    const text = fullText ?? textRef.current?.textContent;

    if (text === undefined) {
      toast.error('Nothing to copy.');

      return;
    }

    toast.success('Copied error to clipboard');
    navigator.clipboard.writeText(text);
    toast.dismiss(t.id);
  }

  return (
    <StyledRow gap='1ch' align='flex-start'>
      {icon}
      <Column gap='0.5rem' align='flex-start'>
        <div ref={textRef}>
          {fullText === undefined ? resolved : shortenSubjects(fullText)}
        </div>
        {reportable && (
          <Button
            subtle
            title='Report this error'
            onClick={() => {
              onReport(reportable);
              toast.dismiss(t.id);
            }}
          >
            <FaComment />
            Report
          </Button>
        )}
      </Column>
      {t.type !== 'loading' && (
        <div
          style={{
            flex: 1,
            flexDirection: 'column',
          }}
        >
          <IconButton title='Clear' onClick={() => toast.dismiss(t.id)}>
            <FaXmark />
          </IconButton>
          {t.type !== 'success' && (
            <IconButton title='Copy' onClick={handleCopy}>
              <FaCopy />
            </IconButton>
          )}
        </div>
      )}
    </StyledRow>
  );
}

const StyledRow = styled(Row)`
  max-height: 16rem;
  overflow-y: auto;
`;
