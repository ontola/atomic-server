import { type Resource, useStore } from '@tomic/react';
import toast from 'react-hot-toast';
import {
  TablePropertyDialog,
  type TablePropertyEditorProps,
} from '@tomic/table';
import { useContext, type JSX } from 'react';
import { PropertyForm } from './PropertyForm';
import { FormValidationContextProvider } from '@components/forms/formValidation/FormValidationContextProvider';
import { AtomicPropertyFrame } from './AtomicPropertyFrame';
import { TablePageContext } from '../tablePageContext';
import {
  prepareAtomicPropertyDraft,
  saveAtomicPropertyDraft,
  type AtomicPropertyDraft,
} from './atomicPropertyDraft';

interface EditPropertyDialogProps {
  resource: Resource;
  showDialog: boolean;
  bindShow: React.Dispatch<boolean>;
  tableClassSubject?: string;
  canSave?: boolean;
}

/** Atomic metadata/services and modal primitives for the shared editor lifecycle. */
export function EditPropertyDialog({
  resource,
  showDialog,
  bindShow,
  tableClassSubject: suppliedClassSubject,
  canSave = true,
}: EditPropertyDialogProps): JSX.Element {
  const store = useStore();
  const { tableClassSubject: contextClassSubject } =
    useContext(TablePageContext);
  const owner = suppliedClassSubject ?? contextClassSubject;

  return (
    <TablePropertyDialog
      open={showDialog}
      scope={JSON.stringify([resource.subject, owner])}
      title='Edit Column'
      canSave={canSave}
      Editor={AtomicPropertyEditor}
      Frame={AtomicPropertyFrame}
      prepare={() => prepareAtomicPropertyDraft(store, resource, owner)}
      save={draft => saveAtomicPropertyDraft(store, draft)}
      isDraftLocked={draft => !!draft.materialized}
      onClose={() => bindShow(false)}
      onError={error => {
        console.error('Failed to save property', error);
        toast.error(`Failed to save column: ${error.message}`);
      }}
      messages={{
        preparing: 'Preparing column…',
        retry: 'Retry',
        save: 'Save',
        cancel: 'Cancel',
        unavailable:
          'Column editing is unavailable. Check access and the selected table.',
        locked:
          'This draft is locked after a partial save. Retry to finish saving.',
      }}
    />
  );
}

function AtomicPropertyEditor({
  draft,
  disabled,
  onSubmit,
  onValidationChange,
}: TablePropertyEditorProps<AtomicPropertyDraft>) {
  return (
    <FormValidationContextProvider onValidationChange={onValidationChange}>
      <PropertyForm
        existingProperty
        resource={draft.resource}
        category={draft.category}
        disabled={disabled}
        onSubmit={onSubmit}
      />
    </FormValidationContextProvider>
  );
}
