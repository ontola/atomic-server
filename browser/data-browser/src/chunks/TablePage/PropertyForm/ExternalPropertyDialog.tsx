import { useState, type JSX } from 'react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { ResourceSelector } from '@components/forms/ResourceSelector';
import { Resource, urls, useArray } from '@tomic/react';
import { Button } from '@components/Button';
import { FormValidationContextProvider } from '@components/forms/formValidation/FormValidationContextProvider';
import { useOnValueChange } from '@helpers/useOnValueChange';

interface ExternalPropertyDialogProps {
  open: boolean;
  bindShow: React.Dispatch<boolean>;
  tableClassResource: Resource;
  /** Called with the property's subject once it's added to the class. */
  onCreated?: (subject: string) => void;
}

export function ExternalPropertyDialog({
  open,
  bindShow,
  tableClassResource,
  onCreated,
}: ExternalPropertyDialogProps): JSX.Element {
  const [subject, setSubject] = useState<string | undefined>();
  const [isValid, setIsValid] = useState(false);

  const [, , pushRecommends] = useArray(
    tableClassResource,
    urls.properties.recommends,
    { commit: true },
  );
  const [dialogProps, show, hide] = useDialog({ bindShow });

  const onAddClick = () => {
    if (subject) {
      pushRecommends([subject]);
      onCreated?.(subject);
      hide();
    }
  };

  useOnValueChange(() => {
    if (open) {
      show();
      setSubject(undefined);
    }
  }, [open]);

  return (
    <Dialog {...dialogProps}>
      <FormValidationContextProvider onValidationChange={setIsValid}>
        <DialogTitle>
          <h1>Add external property</h1>
        </DialogTitle>
        <DialogContent>
          <ResourceSelector
            required
            hideCreateOption
            setSubject={setSubject}
            value={subject}
            isA={urls.classes.property}
          />
        </DialogContent>
        <DialogActions>
          <Button subtle onClick={() => hide()}>
            Cancel
          </Button>
          <Button disabled={!isValid} onClick={onAddClick}>
            Add
          </Button>
        </DialogActions>
      </FormValidationContextProvider>
    </Dialog>
  );
}
