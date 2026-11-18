import { useState, type JSX } from 'react';
import {
  TablePropertyDialog,
  type TablePropertyEditorProps,
} from '@tomic/table';
import { ResourceSelector } from '@components/forms/ResourceSelector';
import { type Resource, urls, useStore } from '@tomic/react';
import { FormValidationContextProvider } from '@components/forms/formValidation/FormValidationContextProvider';
import { AtomicPropertyFrame } from './AtomicPropertyFrame';
import { attachPropertiesToClass } from '../Kanban/createSelectProperty';

interface ExternalPropertyDraft {
  owner: Resource;
  values: Map<string, string | undefined>;
  attaching?: string;
  attached?: string;
}
interface ExternalPropertyDialogProps {
  open: boolean;
  bindShow: React.Dispatch<boolean>;
  tableClassResource: Resource;
  onCreated?: (subject: string) => void;
  scope?: string;
  canSave?: boolean;
}

export function ExternalPropertyDialog({
  open,
  bindShow,
  tableClassResource,
  onCreated,
  scope,
  canSave = true,
}: ExternalPropertyDialogProps): JSX.Element {
  const store = useStore();

  return (
    <TablePropertyDialog<ExternalPropertyDraft>
      open={open}
      title='Add external property'
      scope={scope ?? tableClassResource.subject}
      canSave={canSave}
      Frame={AtomicPropertyFrame}
      Editor={ExternalPropertyEditor}
      prepare={() => ({ owner: tableClassResource, values: new Map() })}
      save={async draft => {
        const subject = draft.attaching ?? draft.values.get('subject');
        if (!subject) throw Error('Choose a property to attach.');
        const property = await store.getResource(subject);
        if (!property.hasClasses(urls.classes.property))
          throw Error('Choose a Property resource.');
        draft.attaching = subject;
        await attachPropertiesToClass(store, draft.owner, [subject]);
        draft.attached = subject;
      }}
      isDraftLocked={draft => !!draft.attaching}
      onClose={() => bindShow(false)}
      onSaved={draft => {
        if (draft.attached) onCreated?.(draft.attached);
      }}
      messages={{
        save: 'Add',
        saveLocked: 'Retry',
        cancel: 'Cancel',
        retry: 'Retry',
        unavailable:
          'Property attachment is unavailable. Check access and the selected table.',
        locked:
          'Attachment started. Retry to finish adding this property to the table.',
      }}
    />
  );
}

function ExternalPropertyEditor({
  draft,
  disabled,
  onValidationChange,
}: TablePropertyEditorProps<ExternalPropertyDraft>) {
  const [subject, setSubject] = useState<string>();

  return (
    <FormValidationContextProvider onValidationChange={onValidationChange}>
      <ResourceSelector
        required
        hideCreateOption
        disabled={disabled}
        setSubject={value => {
          draft.values.set('subject', value);
          setSubject(value);
        }}
        value={subject}
        isA={urls.classes.property}
      />
    </FormValidationContextProvider>
  );
}
