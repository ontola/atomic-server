import type { TablePropertyDialogPresentation } from '@tomic/table';
import { core, useResource, useString, type Property } from '@tomic/react';
import type { InputHTMLAttributes, JSX } from 'react';
import {
  TableRowActionFields,
  TablePropertyDialog,
  type TablePropertyEditorProps,
  type TableViewWriteReceipt,
} from '@tomic/table';
import { AtomicPropertyFrame } from './PropertyForm/AtomicPropertyFrame';
import {
  type ConfiguredColumnDialogDraft,
  saveConfiguredColumnDraft,
} from './configuredColumnDialog';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { PropertyOption } from './DerivedColumnDialog';
import {
  ROW_ACTION_GENERATORS,
  ROW_ACTION_KINDS,
  propertiesForRowAction,
  rowActionValueInput,
  type RowActionSpec,
} from './rowActions';

interface Props {
  open: boolean;
  bindShow: (show: boolean) => void;
  classProperties: Property[];
  /** Set when editing; absent when adding. */
  editing?: RowActionSpec;
  onSave: (spec: RowActionSpec) => TableViewWriteReceipt;
  scope: string;
  canSave?: boolean;
}

/**
 * Configures one row action. The other half of what `configure_view` writes: a
 * button the assistant added has to be editable by the person who owns the table,
 * or they are stuck with whatever it guessed.
 */
export function RowActionDialog({
  open,
  bindShow,
  classProperties,
  editing,
  onSave,
  scope,
  canSave = true,
}: Props): JSX.Element {
  return (
    <TablePropertyDialog<ConfiguredColumnDialogDraft<RowActionSpec>>
      open={open}
      scope={scope}
      canSave={canSave}
      title={editing ? 'Edit action' : 'Add an action'}
      Frame={RowActionFrame}
      Editor={AtomicRowActionEditor}
      prepare={() => ({
        initial: editing ? structuredClone(editing) : undefined,
        properties: [...classProperties],
        values: new Map(),
      })}
      save={draft => saveConfiguredColumnDraft(draft, onSave)}
      isDraftLocked={draft => !!draft.receipt}
      onClose={() => bindShow(false)}
      onDismiss={draft => {
        draft?.receipt?.abandon();
      }}
      messages={{
        save: 'Save',
        saveLocked: 'Retry',
        cancel: 'Cancel',
        cancelLocked: 'Close',
        retry: 'Retry',
        unavailable:
          'The view or column definitions changed. Close this editor and reopen it.',
        locked:
          'Retry to finish saving this change. Closing leaves any partially applied save pending.',
      }}
    />
  );
}

function AtomicRowActionEditor({
  draft,
  disabled,
  onValidationChange,
}: TablePropertyEditorProps<ConfiguredColumnDialogDraft<RowActionSpec>>) {
  const classProperties = draft.properties;
  const kinds = ROW_ACTION_KINDS.map(kind => ({
    kind,
    title: ROW_ACTION_GENERATORS[kind].title,
    description: ROW_ACTION_GENERATORS[kind].description,
    defaultLabel: ROW_ACTION_GENERATORS[kind].defaultLabel,
    valueField: rowActionValueInput(kind),
    targets: propertiesForRowAction(classProperties, kind).map(property => ({
      key: property.subject,
      option: <PropertyOption key={property.subject} property={property} />,
      values: property.allowsOnly?.map(tag => ({
        key: tag,
        option: <TagOption key={tag} subject={tag} />,
      })),
    })),
  }));

  return (
    <TableRowActionFields
      initial={draft.initial}
      kinds={kinds}
      Input={ActionInput}
      disabled={disabled}
      messages={{
        kind: 'Does what',
        property: 'To column',
        pickProperty: 'Pick a column…',
        pickOption: 'Pick an option…',
        label: 'Button says',
        noTargets: 'This table has no column of the right kind for that yet.',
        invalidNumber: 'Enter a finite number.',
      }}
      onChange={(candidate, valid) => {
        draft.values.set('candidate', candidate);
        onValidationChange(valid);
      }}
    />
  );
}

/** A tag's name, for the value picker of a select column. */
export function TagOption({ subject }: { subject: string }): JSX.Element {
  const tag = useResource(subject);
  const [shortname] = useString(tag, core.properties.shortname);

  return <option value={subject}>{shortname ?? tag.title}</option>;
}

function ActionInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <InputWrapper>
      <InputStyled {...props} />
    </InputWrapper>
  );
}

function RowActionFrame(props: TablePropertyDialogPresentation) {
  return <AtomicPropertyFrame {...props} saveTestId='action-config-save' />;
}
