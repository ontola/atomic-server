import toast, {
  type Toast,
  ToastBar,
  Toaster as ReactHotToast,
  resolveValue,
  type Renderable,
} from 'react-hot-toast';
import { FaCopy, FaTimes } from 'react-icons/fa';
import styled, { useTheme } from 'styled-components';
import { zIndex } from '../styling';
import { Row } from './Row';
import { IconButton } from './IconButton/IconButton';

import { useRef, type JSX } from 'react';

/**
 * Makes themed toast notifications available in the Context. Render this
 * somewhere high up in the app
 */
export function Toaster(): JSX.Element {
  const theme = useTheme();

  return (
    <ReactHotToast
      position='bottom-right'
      toastOptions={{
        style: {
          zIndex: zIndex.toast,
          background: theme.colors.bg,
          color: theme.colors.text,
          wordBreak: 'break-word',
        },
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
            <ToastMessage icon={icon} message={message} t={t} />
          )}
        </ToastBar>
      )}
    </ReactHotToast>
  );
}

interface ToastMessageProps {
  icon: React.ReactNode;
  message: Renderable;
  t: Toast;
}

function ToastMessage({ icon, message, t }: ToastMessageProps) {
  const textRef = useRef<HTMLDivElement>(null);

  function handleCopy() {
    const text = textRef.current?.textContent;

    if (text === undefined) {
      toast.error('Nothing to copy.');

      return;
    }

    toast.success('Copied error to clipboard');
    navigator.clipboard.writeText(text);
    toast.dismiss(t.id);
  }

  return (
    <StyledRow gap='1ch' center>
      {icon}
      <div ref={textRef} style={{ display: 'contents' }}>
        {resolveValue(message, t)}
      </div>
      {t.type !== 'loading' && (
        <div
          style={{
            flex: 1,
            flexDirection: 'column',
          }}
        >
          <IconButton title='Clear' onClick={() => toast.dismiss(t.id)}>
            <FaTimes />
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
  max-height: 10rem;
  overflow-y: auto;
`;
