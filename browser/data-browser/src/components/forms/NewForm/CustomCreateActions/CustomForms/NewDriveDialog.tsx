import { useEffect, useRef, type FC } from 'react';
import { useStore } from '@tomic/react';
import { useCreateDrive } from '../../../../../hooks/useCreateDrive';
import type { CustomResourceDialogProps } from '../../useNewResourceUI';

/**
 * A drive needs no input, so there is no dialog: this makes one and closes.
 * It is registered like a dialog because that is how the generic "new
 * resource" path finds a creator for the Drive class.
 */
export const NewDriveDialog: FC<CustomResourceDialogProps> = ({
  onClose,
  onCreated,
  skipNavigation,
}) => {
  const store = useStore();
  const createDrive = useCreateDrive();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    createDrive({ skipNavigation })
      .then(resource => onCreated?.(resource))
      .catch(e => store.notifyError(e))
      .then(onClose);
  });

  return null;
};
