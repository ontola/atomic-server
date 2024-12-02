import toast, {
  type Toast,
  ToastBar,
  Toaster as ReactHotToast,
  type Renderable,
} from 'react-hot-toast';
import { FaCopy, FaTimes } from 'react-icons/fa';
import { useTheme } from 'styled-components';
import { zIndex } from '../styling';
import { Row } from './Row';
import { IconButton } from './IconButton/IconButton';

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
              ? 'toast-enter .5s ease'
              : 'toast-exit 1s ease',
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
  let text: string;

  if (typeof message === 'string') {
    text = message;
  } else if (message && 'props' in message) {
    // children can technically still be a react node but we never do that in our code so we'll just assume it to be a string.
    text = message.props.children;
  } else {
    text = '';
  }

  function handleCopy() {
    toast.success('Copied error to clipboard');
    navigator.clipboard.writeText(text);
    toast.dismiss(t.id);
  }

  if (text.length > 100) {
    text = text.substring(0, 100) + '...';
  }

  return (
    <Row gap='1ch' center>
      {icon}
      {text}
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
    </Row>
  );
}
