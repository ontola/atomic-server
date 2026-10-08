import { Resource, core, useStore } from '@tomic/react';
import toast from 'react-hot-toast';
import { useCallback, useEffect, useState, type JSX } from 'react';
import { PropertyForm } from './PropertyForm';
import { FormValidationContextProvider } from '@components/forms/formValidation/FormValidationContextProvider';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { Button } from '@components/Button';
import { getCategoryFromResource } from './categories';
import {
  applyDraftFields,
  createPropertyDraft,
  isContentAddressed,
  recreatePropertyWithDatatype,
} from '@helpers/propertyIdentity';

interface EditPropertyDialogProps {
  resource: Resource;
  showDialog: boolean;
  bindShow: React.Dispatch<boolean>;
}

export function EditPropertyDialog({
  resource,
  showDialog,
  bindShow,
}: EditPropertyDialogProps): JSX.Element {
  const store = useStore();
  const [valid, setValid] = useState(true);
  // Edits go to a draft copy so a datatype change (which needs a new property)
  // never touches the saved one. A select's tags are children of the property
  // itself and its datatype is fixed, so it edits the property directly.
  const [draft, setDraft] = useState<Resource | null>(null);

  const category = getCategoryFromResource(resource);
  const usesDraft = category !== 'select';

  const onSuccess = useCallback(async () => {
    try {
      if (!draft) {
        await resource.save();

        return;
      }

      const datatypeChanged =
        draft.get(core.properties.datatype) !==
        resource.get(core.properties.datatype);

      if (datatypeChanged && isContentAddressed(resource.subject)) {
        // The datatype is part of the property's ID: make a new property and
        // swap it in. Legacy properties still change in place below.
        // TODO(lenses): values stored under the old property are not migrated.
        await recreatePropertyWithDatatype(store, resource, draft);

        return;
      }

      await applyDraftFields(resource, draft);
      await resource.save();
    } catch (err) {
      console.error('Failed to save property', err);
      toast.error(`Failed to save column: ${(err as Error).message}`);
    }
  }, [store, resource, draft]);

  const [dialogProps, show, hide, visible] = useDialog({ bindShow, onSuccess });

  useEffect(() => {
    if (!showDialog) {
      hide();
      setDraft(null);

      return;
    }

    let cancelled = false;

    (async () => {
      if (usesDraft) {
        const created = await createPropertyDraft(
          store,
          resource.get(core.properties.parent) as string,
          { source: resource },
        );

        if (cancelled) {
          return;
        }

        setDraft(created);
      }

      show();
    })().catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [showDialog]);

  const handleSaveClick = useCallback(() => {
    hide(true);
  }, [hide]);

  return (
    <FormValidationContextProvider onValidationChange={setValid}>
      <Dialog {...dialogProps}>
        <DialogTitle>
          <h1>Edit Column</h1>
        </DialogTitle>
        <DialogContent>
          {visible && (draft || !usesDraft) && (
            <PropertyForm
              existingProperty
              resource={draft ?? resource}
              category={category}
              onSubmit={handleSaveClick}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleSaveClick} disabled={!valid}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </FormValidationContextProvider>
  );
}
