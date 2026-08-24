import { useEffect, useRef, type FC } from 'react';
import { styled } from 'styled-components';
import type { Resource } from '@tomic/react';
import { NewDriveSetup } from '../../../../Drives/NewDriveSetup';
import {
  useDialog,
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../../../Dialog';
import { CustomResourceDialogProps } from '../../useNewResourceUI';
import { useNavigateWithTransition } from '../../../../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../../../../helpers/navigation';

export const NewDriveDialog: FC<CustomResourceDialogProps> = ({
  onClose,
  onCreated,
  skipNavigation,
}) => {
  const navigate = useNavigateWithTransition();
  const createdRef = useRef<Resource | undefined>(undefined);

  const finish = (resource?: Resource) => {
    const created = resource ?? createdRef.current;

    if (created && !skipNavigation) {
      navigate(constructOpenURL(created.subject));
    }

    onClose();
  };

  const [dialogProps, show, hide] = useDialog({
    onCancel: () => finish(),
    onSuccess: onClose,
  });

  useEffect(() => {
    show();
  }, [show]);

  return (
    <Dialog {...dialogProps} width='50rem'>
      <DialogTitle>
        <H1>New Drive</H1>
      </DialogTitle>
      <DialogContent>
        <NewDriveSetup
          onCreated={resource => {
            createdRef.current = resource;
            onCreated?.(resource);
          }}
          onClose={() => hide(true)}
          skipNavigation={skipNavigation}
        />
      </DialogContent>
    </Dialog>
  );
};

const H1 = styled.h1`
  margin: 0;
`;
