import { useEffect, useRef, useState, type FC } from 'react';
import { useStore, type Resource } from '@tomic/react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  useDialog,
} from '../../../../Dialog';
import { Button } from '../../../../Button';
import { Column, Row } from '../../../../Row';
import { ErrorBlock } from '../../../../ErrorLook';
import Field from '../../../Field';
import { InputStyled, InputWrapper } from '../../../InputStyles';
import { useSettings } from '../../../../../helpers/AppSettings';
import { getManagedPortalUrl } from '../../../../../helpers/managed/cloudSync';
import { useNavigateWithTransition } from '../../../../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../../../../helpers/navigation';
import { prepareTemplateDrive } from '../../../../../chunks/Templates/prepareTemplateDrive';
import type { CustomResourceDialogProps } from '../../useNewResourceUI';

/** A drive is made from a name alone; what goes in it comes after. */
export function NewDriveForm({
  onCreated,
  onCancel,
}: {
  onCreated: (resource: Resource) => void;
  /** Adds a Cancel button next to Create. */
  onCancel?: () => void;
}) {
  const store = useStore();
  const [name, setName] = useState('My drive');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<Error>();

  async function create() {
    if (!name.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);

    try {
      await prepareTemplateDrive(store);
      const resource = await store.createDrive(name.trim(), {
        personal: false,
        localOnly: !!getManagedPortalUrl(),
      });
      await store.notifyResourceManuallyCreated(resource);
      onCreated(resource);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        void create();
      }}
    >
      <Column>
        {error && <ErrorBlock error={error} />}
        <Field label='Drive name' fieldId='new-drive-name' required>
          <InputWrapper>
            <InputStyled
              id='new-drive-name'
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              onFocus={event => event.currentTarget.select()}
              disabled={busy}
            />
          </InputWrapper>
        </Field>
        <Row>
          <Button type='submit' disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create drive'}
          </Button>
          {onCancel && (
            <Button subtle type='button' disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Row>
      </Column>
    </form>
  );
}

export const NewDriveDialog: FC<CustomResourceDialogProps> = ({
  onClose,
  onCreated,
  skipNavigation,
}) => {
  const { setDrive } = useSettings();
  const navigate = useNavigateWithTransition();
  const [dialogProps, show] = useDialog({ onCancel: onClose });
  useEffect(() => {
    show();
  }, [show]);

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h2>New drive</h2>
      </DialogTitle>
      <DialogContent>
        <NewDriveForm
          onCreated={resource => {
            setDrive(resource.subject);
            onCreated?.(resource);
            onClose();
            if (!skipNavigation) navigate(constructOpenURL(resource.subject));
          }}
        />
      </DialogContent>
    </Dialog>
  );
};
