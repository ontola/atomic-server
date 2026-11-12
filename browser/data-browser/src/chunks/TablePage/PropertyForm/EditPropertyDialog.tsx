import {
  Resource,
  core,
  dataBrowser,
  getEffectiveConstraint,
  setClassConstraint,
  useStore,
} from '@tomic/react';
import toast from 'react-hot-toast';
import { useTableDraftCommit } from '@tomic/table';
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  type JSX,
} from 'react';
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
import { TablePageContext } from '../tablePageContext';
import {
  CONSTRAINT_FIELDS,
  applyDraftConstraint,
  seedDraftFromConstraint,
} from './columnConstraints';
import {
  applyDraftFields,
  createPropertyDraft,
  isContentAddressed,
  recreatePropertyWithDatatype,
} from '@helpers/propertyIdentity';

// What an immutable Property leaves to the table class's constraints.
const CONSTRAINT_OMIT = {
  fields: CONSTRAINT_FIELDS,
  classes: [dataBrowser.classes.rangeProperty],
};

interface EditPropertyDialogProps {
  resource: Resource;
  showDialog: boolean;
  bindShow: React.Dispatch<boolean>;
  tableClassSubject?: string;
}

export function EditPropertyDialog({
  resource,
  showDialog,
  bindShow,
  tableClassSubject: suppliedClassSubject,
}: EditPropertyDialogProps): JSX.Element {
  const store = useStore();
  const { tableClassSubject: contextClassSubject } =
    useContext(TablePageContext);
  const tableClassSubject = suppliedClassSubject ?? contextClassSubject;
  const draftScope = JSON.stringify([resource.subject, tableClassSubject]);
  const [valid, setValid] = useState(true);
  // Edits go to a draft copy so a datatype change (which needs a new property)
  // never touches the saved one. A select's tags are children of the property
  // itself and its datatype is fixed, so it edits the property directly.
  const [prepared, setDraft] = useState<{
    scope: string;
    resource: Resource;
  } | null>(null);
  const draft = prepared?.scope === draftScope ? prepared.resource : null;

  const category = getCategoryFromResource(resource);
  const usesDraft = category !== 'select';
  const {
    busy,
    error,
    run: commitDraft,
  } = useTableDraftCommit(JSON.stringify([draftScope, showDialog]));

  const saveProperty = useCallback(async () => {
    if (!draft) {
      await resource.save();

      return;
    }

    const datatypeChanged =
      draft.get(core.properties.datatype) !==
      resource.get(core.properties.datatype);
    const contentAddressed = isContentAddressed(resource.subject);
    const tableClass = await store.getResource(tableClassSubject);
    const hasClass = tableClass.hasClasses(core.classes.class);

    if (datatypeChanged && contentAddressed) {
      // The datatype is part of the property's ID: make a new property and
      // swap it in; a lens carries the stored values over. Legacy
      // properties still change in place below.
      const created = await recreatePropertyWithDatatype(
        store,
        resource,
        draft,
        hasClass ? [tableClass] : [],
        CONSTRAINT_OMIT,
      );

      if (hasClass) {
        // The limits and linked class follow the column to its new property.
        await setClassConstraint(tableClass, resource.subject, undefined);
        await applyDraftConstraint(tableClass, created.subject, draft);
        await tableClass.save();
      }

      return;
    }

    // Limits and the linked class are the class's, not the Property's. A
    // legacy property keeps its own copy in step for readers that predate
    // the class map.
    await applyDraftFields(
      resource,
      draft,
      contentAddressed ? CONSTRAINT_OMIT : undefined,
    );
    await resource.save();

    if (hasClass) {
      await applyDraftConstraint(tableClass, resource.subject, draft);
      await tableClass.save();
    }
  }, [store, resource, draft, tableClassSubject]);

  const [dialogProps, show, hide, visible] = useDialog({ bindShow });

  const prepareDraft = useEffectEvent(async (isCancelled: () => boolean) => {
    if (usesDraft) {
      const created = await createPropertyDraft(
        store,
        resource.get(core.properties.parent) as string,
        { source: resource },
      );
      if (isCancelled()) return;
      seedDraftFromConstraint(
        created,
        getEffectiveConstraint(store, [tableClassSubject], resource.subject),
      );
      setDraft({ scope: draftScope, resource: created });
    }

    if (!isCancelled()) show();
  });
  const closeEditor = useEffectEvent(() => hide());

  useEffect(() => {
    if (!showDialog) {
      closeEditor();
      setDraft(null);

      return;
    }

    let cancelled = false;
    void prepareDraft(() => cancelled).catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [showDialog, draftScope]);

  const handleSaveClick = useCallback(async () => {
    const result = await commitDraft(
      saveProperty,
      valid && (!usesDraft || !!draft),
    );
    if (result.status === 'saved') hide(true);

    if (result.status === 'failed') {
      console.error('Failed to save property', result.error);
      toast.error(`Failed to save column: ${result.error.message}`);
    }
  }, [commitDraft, saveProperty, valid, usesDraft, draft, hide]);

  return (
    <FormValidationContextProvider onValidationChange={setValid}>
      <Dialog
        {...dialogProps}
        onClose={success => {
          if (!busy) hide(success);
        }}
      >
        <DialogTitle>
          <h1>Edit Column</h1>
        </DialogTitle>
        <DialogContent>
          {error && <div role='alert'>{error.message}</div>}
          <div inert={busy}>
            {visible && (draft || !usesDraft) && (
              <PropertyForm
                existingProperty
                resource={draft ?? resource}
                category={category}
                onSubmit={() => {
                  void handleSaveClick();
                }}
              />
            )}
          </div>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              void handleSaveClick();
            }}
            disabled={!valid || busy || (usesDraft && !draft)}
            aria-busy={busy}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </FormValidationContextProvider>
  );
}
