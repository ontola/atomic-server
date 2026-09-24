import { useStore } from '@tomic/react';
import { FeedbackDiagnostics } from './FeedbackDiagnostics';
import {
  currentDiagnosticText,
  type DiagnosticPreview,
} from '../../helpers/diagnostic-report';
import { useId, useRef, useState } from 'react';
import { FaComment } from 'react-icons/fa6';
import * as Sentry from '@sentry/react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  useDialog,
} from '../Dialog';
import {
  InputStyled,
  InputWrapper,
  TextAreaStyled,
} from '../forms/InputStyles';
import { Button } from '../Button';
import Field from '../forms/Field';
import { Column } from '../Row';
import {
  SideBarMenuRow,
  SideBarMenuRowIcon,
  SideBarMenuRowLabel,
} from './SideBarMenuItem';
import {
  errorFeedbackMessage,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  submitFeedback,
} from '../../helpers/feedback';

export function FeedbackMenuItem({
  floating = false,
  reportError,
}: {
  floating?: boolean;
  reportError?: Error;
}) {
  const store = useStore();
  const [diagnosticPreview, setDiagnosticPreview] =
    useState<DiagnosticPreview>();
  const feedbackTitle = reportError ? 'Report this error' : 'Send feedback';
  const messageId = useId();
  const emailId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const [dialogProps, showDialog, hideDialog] = useDialog({ triggerRef });
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sent, setSent] = useState(false);
  const enabled = Sentry.isEnabled();

  async function send() {
    if (!emailRef.current?.reportValidity()) return;
    setBusy(true);
    setFailed(false);

    try {
      await submitFeedback(
        message,
        email,
        reportError ? 'error' : 'sidebar',
        currentDiagnosticText(store.diagnostics, diagnosticPreview),
      );
      setDiagnosticPreview(undefined);
      setSent(true);
      setMessage('');
    } catch {
      setFailed(true);
    }

    setBusy(false);
  }

  function open() {
    setSent(false);
    if (reportError) setMessage(errorFeedbackMessage(reportError));
    showDialog();
  }

  return (
    <>
      {floating ? (
        <Button subtle ref={triggerRef} onClick={open}>
          <FaComment aria-hidden />
          {reportError ? 'Report this error' : 'Feedback'}
        </Button>
      ) : (
        <SideBarMenuRow
          as='button'
          ref={triggerRef}
          type='button'
          onClick={open}
          style={{
            border: 0,
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          <SideBarMenuRowIcon>
            <FaComment />
          </SideBarMenuRowIcon>
          <SideBarMenuRowLabel>Feedback</SideBarMenuRowLabel>
        </SideBarMenuRow>
      )}
      <Dialog {...dialogProps} hideOnboardingFeedback>
        <DialogTitle>
          <h1>{feedbackTitle}</h1>
        </DialogTitle>
        <DialogContent>
          {sent ? (
            <p role='status'>Thank you. Your feedback has been received.</p>
          ) : (
            <Column>
              <p>
                Report a bug or suggest an improvement. Your message and
                optional email go to the Atomic team through Sentry. Please
                leave out private workspace content.
              </p>
              <Field label='Feedback' fieldId={messageId} disabled={busy}>
                <InputWrapper>
                  <TextAreaStyled
                    id={messageId}
                    rows={5}
                    maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
                    value={message}
                    onChange={event => setMessage(event.target.value)}
                    disabled={busy}
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                </InputWrapper>
              </Field>
              {dialogProps.show && (
                <FeedbackDiagnostics
                  onSelect={setDiagnosticPreview}
                  disabled={busy}
                >
                  <Field
                    label='Email for a reply (optional)'
                    fieldId={emailId}
                    disabled={busy}
                  >
                    <InputWrapper>
                      <InputStyled
                        id={emailId}
                        type='email'
                        ref={emailRef}
                        value={email}
                        onChange={event => setEmail(event.target.value)}
                        disabled={busy}
                      />
                    </InputWrapper>
                  </Field>
                </FeedbackDiagnostics>
              )}
              {!enabled && (
                <p role='status'>
                  Feedback reporting is unavailable on this installation. Email{' '}
                  <a href='mailto:info@ontola.io'>
                    {/* @wc-ignore */ 'info@ontola.io'}
                  </a>
                  .
                </p>
              )}
              {failed && (
                <p role='alert'>
                  Feedback could not be sent. Your text is still here. Try again
                  or email{' '}
                  <a href='mailto:info@ontola.io'>
                    {/* @wc-ignore */ 'info@ontola.io'}
                  </a>
                  .
                </p>
              )}
            </Column>
          )}
        </DialogContent>
        <DialogActions>
          <Button subtle onClick={() => hideDialog(false)} disabled={busy}>
            Close
          </Button>
          {!sent && (
            <Button
              onClick={send}
              disabled={!enabled || !message.trim() || busy}
              loading={busy ? 'Sending feedback' : undefined}
            >
              Send feedback
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
