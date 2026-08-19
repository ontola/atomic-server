import { useEffect, useState } from 'react';
import {
  createDirectMessage,
  listCollaborators,
  useDrive,
  useStore,
} from '@tomic/react';
import { FaPaperPlane } from 'react-icons/fa6';
import toast from 'react-hot-toast';
import { Button } from './Button';
import { Dialog, useDialog } from './Dialog';
import { Column } from './Row';
import Field from './forms/Field';
import { DropdownInput } from './forms/ResourceSelector/DropdownInput';
import { InputWrapper, TextAreaStyled } from './forms/InputStyles';
import { ErrorLook } from './ErrorLook';
import { useSettings } from '../helpers/AppSettings';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';
import { getOrCreateNotificationsFolder } from '../helpers/notificationsFolder';

/**
 * Compose a DirectMessage to another agent on the current drive.
 * Recipients are drive collaborators (read/write), excluding yourself.
 */
export function SendMessageButton(): React.JSX.Element | null {
  const store = useStore();
  const { agent } = useSettings();
  const [drive] = useDrive();
  const [dialogProps, show, close, isOpen] = useDialog();
  const [recipient, setRecipient] = useState<string | undefined>();
  const [body, setBody] = useState('');
  const [options, setOptions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!isOpen || !drive || !agent?.subject) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const driveRes = await store.getResource(drive);
        const collabs = await listCollaborators(driveRes, {
          exclude: agent.subject,
        });

        if (!cancelled) {
          setOptions(collabs);
        }
      } catch {
        if (!cancelled) {
          setOptions([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, drive, agent?.subject, store]);

  if (!agent) {
    return null;
  }

  const send = async () => {
    if (busy || !agent.subject || !recipient || !body.trim()) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      const personalDrive = await fetchPrivateDriveSubject(store, agent);
      const fallback = personalDrive
        ? await getOrCreateNotificationsFolder(store, personalDrive)
        : drive;

      if (!fallback) {
        setError('No drive to save the message on.');
        setBusy(false);

        return;
      }

      await createDirectMessage({
        store,
        preferredParent: drive,
        fallbackParent: fallback,
        recipient,
        body: body.trim(),
        sender: agent.subject,
      });
      toast.success('Message sent');
      setBody('');
      setRecipient(undefined);
      setBusy(false);
      close(true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <Button subtle data-testid='send-message' onClick={show}>
        <FaPaperPlane />
        Send message
      </Button>
      <Dialog {...dialogProps} width='420px'>
        {isOpen && (
          <>
            <Dialog.Title>
              <h2 data-testid='send-message-title'>Send message</h2>
            </Dialog.Title>
            <Dialog.Content>
              <Column gap='1rem'>
                {options.length === 0 ? (
                  <p>
                    No one else has access to this drive yet. Share it or create
                    an invite first, then you can message them.
                  </p>
                ) : (
                  <>
                    <Field label='To' required>
                      <DropdownInput
                        placeholder='Choose a person…'
                        options={options}
                        initial={recipient}
                        onUpdate={value => setRecipient(value)}
                      />
                    </Field>
                    <Field label='Message' required>
                      <InputWrapper>
                        <TextAreaStyled
                          data-testid='send-message-body'
                          value={body}
                          onChange={e => setBody(e.target.value)}
                          placeholder='Write a message…'
                          rows={4}
                        />
                      </InputWrapper>
                    </Field>
                  </>
                )}
                {error && <ErrorLook>{error}</ErrorLook>}
              </Column>
            </Dialog.Content>
            <Dialog.Actions>
              <Button
                onClick={() => void send()}
                disabled={busy || !recipient || !body.trim()}
                data-testid='send-message-submit'
              >
                <FaPaperPlane />
                Send
              </Button>
            </Dialog.Actions>
          </>
        )}
      </Dialog>
    </>
  );
}
