import { useEffect, useId, useState } from 'react';
import { ai, type Ai, useStore } from '@tomic/react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from '@components/Dialog';
import { Button } from '@components/Button';
import { Column } from '@components/Row';
import { InputWrapper, TextAreaStyled } from '@components/forms/InputStyles';
import { messageResourcesToDisplayMessages } from './chatConversionUtils';
import {
  formatAIChatReport,
  MAX_AI_CHAT_REPORT_LENGTH,
} from './formatAIChatReport';

/** Prepares a reviewable transcript locally; this component makes no network request. */
export default function ReportAIChatDialog({
  subject,
  show,
  onClose,
  onClosed,
}: {
  subject: string;
  show: boolean;
  onClose: () => void;
  onClosed: () => void;
}) {
  const store = useStore();
  const detailsId = useId();
  const transcriptId = useId();
  const [details, setDetails] = useState('');
  const [transcript, setTranscript] = useState('');
  const [omittedMessages, setOmittedMessages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);

    void (async () => {
      try {
        const chat = await store.getResource<Ai.AiChat>(subject);
        const subjects =
          (chat.get(ai.properties.messages) as string[] | undefined) ?? [];
        const messages = await messageResourcesToDisplayMessages(
          subjects,
          store,
        );
        const report = formatAIChatReport(
          chat.title,
          Array.from(messages.keys()),
        );

        if (!cancelled) {
          setTranscript(report.text);
          setOmittedMessages(report.omittedMessages);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [show, subject, store]);

  async function copy() {
    setCopyFailed(false);
    setCopied(false);

    try {
      await navigator.clipboard.writeText(
        `What went wrong:\n${details.trim() || '(No description)'}\n\n${transcript}`,
      );
      setCopied(true);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <Dialog
      show={show}
      onClose={onClose}
      onClosed={onClosed}
      hideOnboardingFeedback
      width='min(42rem, 100%)'
    >
      <DialogTitle>
        <h1>Report AI chat</h1>
      </DialogTitle>
      <DialogContent>
        <Column>
          <p>
            Review or remove private information before sharing this report.
            Attachments, tool payloads, and reasoning are excluded. Nothing is
            sent automatically.
          </p>
          {loading ? (
            <p role='status'>Preparing chat transcript…</p>
          ) : loadFailed ? (
            <p role='alert'>The chat could not be loaded. Try again.</p>
          ) : (
            <>
              <label htmlFor={detailsId}>
                What went wrong?
                <InputWrapper>
                  <TextAreaStyled
                    id={detailsId}
                    rows={3}
                    maxLength={2000}
                    value={details}
                    onChange={event => setDetails(event.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                </InputWrapper>
              </label>
              <label htmlFor={transcriptId}>
                Chat transcript (editable)
                <InputWrapper>
                  <TextAreaStyled
                    id={transcriptId}
                    rows={12}
                    maxLength={MAX_AI_CHAT_REPORT_LENGTH}
                    value={transcript}
                    onChange={event => setTranscript(event.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                </InputWrapper>
              </label>
              {omittedMessages > 0 && (
                <p role='status'>
                  {omittedMessages} earlier messages were omitted to fit the
                  report. The most recent messages are included.
                </p>
              )}
              {copied && <p role='status'>Report copied to clipboard.</p>}
              {copyFailed && (
                <p role='alert'>
                  Could not copy. Select the text above to copy it manually.
                </p>
              )}
            </>
          )}
        </Column>
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={onClose}>
          Close
        </Button>
        <Button
          onClick={() => void copy()}
          disabled={loading || loadFailed || !transcript.trim()}
        >
          Copy report
        </Button>
      </DialogActions>
    </Dialog>
  );
}
