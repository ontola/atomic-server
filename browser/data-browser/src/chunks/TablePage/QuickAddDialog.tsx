import type { Property } from '@tomic/react';
import { useEffect, useState } from 'react';
import {
  TablePropertyDialog,
  type TablePropertyEditorProps,
  type TablePropertyDialogPresentation,
  type TableViewWriteReceipt,
} from '@tomic/table';
import { AtomicPropertyFrame } from './PropertyForm/AtomicPropertyFrame';
import {
  QuickAddFields,
  draftFromSpec,
  isQuickAddDraftComplete,
  specFromDraft,
  type QuickAddDraft,
} from './QuickAddFields';
import type { QuickAddSpec } from './quickAdd';
interface Draft {
  initial: QuickAddDraft;
  properties: Property[];
  values: Map<string, QuickAddSpec>;
  receipt?: TableViewWriteReceipt;
}
interface Props {
  open: boolean;
  bindShow: (show: boolean) => void;
  classProperties: Property[];
  editing?: QuickAddSpec;
  onSave: (spec: QuickAddSpec | undefined) => TableViewWriteReceipt;
  scope: string;
  canSave: boolean;
}

/** Page-owned create-button configuration, retained until its own view write succeeds. */
export function QuickAddDialog({
  open,
  bindShow,
  classProperties,
  editing,
  onSave,
  scope,
  canSave,
}: Props) {
  return (
    <TablePropertyDialog<Draft>
      open={open}
      scope={scope}
      canSave={canSave}
      title={editing ? 'Edit the add button' : 'Add a create button'}
      Frame={QuickAddFrame}
      Editor={QuickAddEditor}
      prepare={() => ({
        initial: draftFromSpec(editing),
        properties: [...classProperties],
        values: new Map(),
      })}
      save={draft => commitQuickAdd(draft, false, onSave)}
      remove={
        editing ? draft => commitQuickAdd(draft, true, onSave) : undefined
      }
      isDraftLocked={draft => !!draft.receipt}
      onClose={() => bindShow(false)}
      onDismiss={draft => {
        draft?.receipt?.abandon();
      }}
      messages={{
        save: 'Save',
        saveLocked: 'Retry',
        remove: 'Remove',
        cancel: 'Cancel',
        cancelLocked: 'Close',
        unavailable:
          'The view or column definitions changed. Close this editor and reopen it.',
        locked:
          'Retry to finish saving this change. Closing leaves any partially applied save pending.',
      }}
    />
  );
}

function QuickAddEditor({
  draft,
  disabled,
  onValidationChange,
}: TablePropertyEditorProps<Draft>) {
  const [value, setValue] = useState(draft.initial);
  const valid = isQuickAddDraftComplete(value, draft.properties);
  useEffect(() => {
    if (valid)
      draft.values.set('candidate', specFromDraft(value, draft.properties));
    else draft.values.delete('candidate');
    onValidationChange(valid && !disabled);
  }, [value, valid, disabled, draft, onValidationChange]);

  return (
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
      <p>
        It sits above the rows and creates one. Everything else about the row is
        edited in the table.
      </p>
      <QuickAddFields
        draft={value}
        onChange={setValue}
        classProperties={draft.properties}
      />
    </fieldset>
  );
}

function QuickAddFrame(props: TablePropertyDialogPresentation) {
  return (
    <AtomicPropertyFrame
      {...props}
      saveTestId='quick-add-config-save'
      removeTestId='quick-add-config-remove'
    />
  );
}

async function commitQuickAdd(
  draft: Draft,
  removing: boolean,
  onSave: Props['onSave'],
) {
  const candidate = draft.values.get('candidate');
  if (!removing && !candidate && !draft.receipt)
    throw Error('Complete the create-button configuration before saving.');
  draft.receipt ??= onSave(removing ? undefined : structuredClone(candidate!));
  await draft.receipt.retry();
}
