import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@tomic/resource-ui/components/Dialog/index';
import { ResourceSelector } from '@tomic/resource-ui/components/forms/ResourceSelector/index';
import { Resource, core, urls, useCanWrite } from '@tomic/react';
import { Button } from '@tomic/ui/components/Button';
import { FormValidationContextProvider } from '@tomic/resource-ui/components/forms/formValidation/FormValidationContextProvider';
import { ErrorChip } from '@tomic/resource-ui/components/forms/ErrorChip';
import { saveTableChange } from '../tableSave.js';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const currentClass = useRef<Resource | undefined>(undefined);
  const canWrite = useCanWrite(tableClassResource);
  const [dialogProps, show, hide] = useDialog({ bindShow });

  useLayoutEffect(() => {
    currentClass.current = tableClassResource;

    return () => {
      currentClass.current = undefined;
    };
  }, [tableClassResource]);

  const onAddClick = async () => {
    if (!subject || !canWrite || pending.current) return;

    pending.current = true;
    setBusy(true);
    setError(undefined);

    try {
      const recommends = tableClassResource.getSubjects(
        core.properties.recommends,
      );
      const requires = tableClassResource.getSubjects(core.properties.requires);

      if (!recommends.includes(subject) && !requires.includes(subject)) {
        await tableClassResource.set(core.properties.recommends, [
          ...recommends,
          subject,
        ]);
      }

      await saveTableChange(tableClassResource);

      if (currentClass.current === tableClassResource) {
        onCreated?.(subject);
        hide(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (open) {
      show();
      setSubject(undefined);
      setError(undefined);
    }
  }, [open, show]);

  const cancel = () => {
    if (!pending.current) hide();
  };

  return (
    <Dialog
      {...dialogProps}
      aria-busy={busy}
      disableLightDismiss={busy}
      onClose={cancel}
    >
      <FormValidationContextProvider onValidationChange={setIsValid}>
        <DialogTitle>
          <h1>Add external property</h1>
        </DialogTitle>
        <DialogContent>
          <ResourceSelector
            required
            hideCreateOption
            setSubject={next => {
              if (!pending.current) setSubject(next);
            }}
            value={subject}
            isA={urls.classes.property}
          />
          {error && <ErrorChip role='alert'>{error}</ErrorChip>}
        </DialogContent>
        <DialogActions>
          <Button subtle disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button
            disabled={!isValid || !subject || !canWrite || busy}
            onClick={onAddClick}
          >
            Add
          </Button>
        </DialogActions>
      </FormValidationContextProvider>
    </Dialog>
  );
}
