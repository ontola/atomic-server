import { type Core, type Resource, useStore } from '@tomic/react';
import {
  TablePropertyDialog,
  type TablePropertyEditorProps,
} from '@tomic/table';
import type { JSX } from 'react';
import { AtomicPropertyFrame } from './AtomicPropertyFrame';
import { FormValidationContextProvider } from '@components/forms/formValidation/FormValidationContextProvider';
import { PropertyForm } from './PropertyForm';
import {
  prepareAtomicNewPropertyDraft,
  saveAtomicNewPropertyDraft,
  type AtomicNewPropertyDraft,
} from './atomicNewPropertyDraft';
interface NewPropertyDialogProps {
  showDialog: boolean;
  tableClassResource: Resource<Core.Class>;
  bindShow: React.Dispatch<boolean>;
  selectedCategory?: string;
  onCreated?: (subject: string) => void;
  canSave?: boolean;
  scope?: string;
}

export function NewPropertyDialog({
  showDialog,
  selectedCategory,
  tableClassResource,
  bindShow,
  onCreated,
  canSave = true,
  scope,
}: NewPropertyDialogProps): JSX.Element {
  const store = useStore();
  const kind = selectedCategory
    ? selectedCategory[0].toUpperCase() + selectedCategory.slice(1)
    : '';

  return (
    <TablePropertyDialog
      open={showDialog}
      scope={JSON.stringify([
        scope ?? tableClassResource.subject,
        selectedCategory,
      ])}
      title={`New ${kind} Column`}
      canSave={canSave}
      Frame={AtomicPropertyFrame}
      Editor={AtomicNewPropertyEditor}
      prepare={() =>
        prepareAtomicNewPropertyDraft(
          store,
          tableClassResource,
          selectedCategory,
        )
      }
      save={draft => saveAtomicNewPropertyDraft(store, draft)}
      isDraftLocked={draft => !!draft.created}
      onClose={() => bindShow(false)}
      onSaved={draft => {
        if (draft.created) onCreated?.(draft.created);
      }}
      messages={{
        preparing: 'Preparing column…',
        retry: 'Retry',
        save: 'Create',
        saveLocked: 'Retry',
        cancel: 'Cancel',
        unavailable:
          'Column creation is unavailable. Check access and the selected table.',
        locked:
          'Column definition saved. Retry to finish adding it to the table.',
      }}
    />
  );
}

function AtomicNewPropertyEditor({
  draft,
  disabled,
  onSubmit,
  onValidationChange,
}: TablePropertyEditorProps<AtomicNewPropertyDraft>) {
  return (
    <FormValidationContextProvider onValidationChange={onValidationChange}>
      <PropertyForm
        resource={draft.resource}
        category={draft.category}
        disabled={disabled}
        onSubmit={onSubmit}
        autoFocusName
      />
    </FormValidationContextProvider>
  );
}
