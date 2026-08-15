import { useEffect, useState } from 'react';
import {
  createAccessRequest,
  listAccessRequestRecipients,
  useStore,
  type RequestedRight,
  type Resource,
} from '@tomic/react';
import { FaUnlockKeyhole } from 'react-icons/fa6';
import toast from 'react-hot-toast';
import { Button } from './Button';
import { Dialog, useDialog } from './Dialog';
import { Column } from './Row';
import Field from './forms/Field';
import { RadioInput } from './forms/RadioInput';
import { InputWrapper, TextAreaStyled } from './forms/InputStyles';
import { ErrorLook } from './ErrorLook';
import { useSettings } from '../helpers/AppSettings';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';
import { getOrCreateNotificationsFolder } from '../helpers/notificationsFolder';

interface RequestAccessButtonProps {
  resource: Resource;
}

/**
 * Ask writers of a resource to add you to read or write. Creates an
 * AccessRequest that mentions those agents; their NotificationEngine
 * materializes an inbox item with a Grant action.
 */
export function RequestAccessButton({
  resource,
}: RequestAccessButtonProps): React.JSX.Element | null {
  const store = useStore();
  const { agent } = useSettings();
  const [dialogProps, show, close, isOpen] = useDialog();
  const [right, setRight] = useState<RequestedRight>('read');
  const [message, setMessage] = useState('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!isOpen || !agent?.subject) {
      return;
    }

    let cancelled = false;

    void listAccessRequestRecipients(resource, agent.subject).then(list => {
      if (!cancelled) {
        setRecipients(list);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, resource, agent?.subject]);

  if (!agent) {
    return null;
  }

  const submit = async () => {
    if (busy || !agent.subject) {
      return;
    }

    if (recipients.length === 0) {
      setError('Could not find anyone who can grant access.');

      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      const personalDrive = await fetchPrivateDriveSubject(store, agent);

      if (!personalDrive) {
        setError('No personal drive to store the request on.');
        setBusy(false);

        return;
      }

      const folder = await getOrCreateNotificationsFolder(store, personalDrive);
      await createAccessRequest({
        store,
        target: resource,
        recipients,
        requestedRight: right,
        message: message.trim() || undefined,
        requester: agent.subject,
        fallbackParent: folder,
      });
      toast.success('Access request sent');
      setMessage('');
      setBusy(false);
      close(true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <Button subtle data-testid='request-access' onClick={show}>
        <FaUnlockKeyhole />
        Request access
      </Button>
      <Dialog {...dialogProps} width='420px'>
        {isOpen && (
          <>
            <Dialog.Title>
              <h2>Request access</h2>
            </Dialog.Title>
            <Dialog.Content>
              <Column gap='1rem'>
                <p>
                  The people who can already write this resource will get a
                  notification. They can grant you read or write from their
                  inbox.
                </p>
                <Field label='I need' multiInput>
                  <Column gap='0.4rem'>
                    <RadioInput
                      name='requested-right'
                      checked={right === 'read'}
                      onChange={() => setRight('read')}
                    >
                      Read
                    </RadioInput>
                    <RadioInput
                      name='requested-right'
                      checked={right === 'write'}
                      onChange={() => setRight('write')}
                    >
                      Write
                    </RadioInput>
                  </Column>
                </Field>
                <Field label='Message (optional)'>
                  <InputWrapper>
                    <TextAreaStyled
                      data-testid='request-access-message'
                      value={message}
                      onChange={e => setMessage(e.target.value)}
                      placeholder='Why do you need access?'
                      rows={3}
                    />
                  </InputWrapper>
                </Field>
                {recipients.length === 0 && (
                  <p>No writers found to notify for this resource.</p>
                )}
                {error && <ErrorLook>{error}</ErrorLook>}
              </Column>
            </Dialog.Content>
            <Dialog.Actions>
              <Button
                onClick={() => void submit()}
                disabled={busy || recipients.length === 0}
                data-testid='request-access-submit'
              >
                Send request
              </Button>
            </Dialog.Actions>
          </>
        )}
      </Dialog>
    </>
  );
}
