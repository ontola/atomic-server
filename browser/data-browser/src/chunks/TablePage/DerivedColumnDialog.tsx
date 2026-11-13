import type { TablePropertyDialogPresentation } from '@tomic/table';
import { Button } from '@components/Button';
import { AtomicPropertyFrame } from './PropertyForm/AtomicPropertyFrame';
import {
  type ConfiguredColumnDialogDraft,
  saveConfiguredColumnDraft,
} from './configuredColumnDialog';
import type { InputHTMLAttributes, JSX } from 'react';
import {
  TableDerivedColumnFields,
  TablePropertyDialog,
  type TablePropertyEditorProps,
  type TableViewWriteReceipt,
  type TableQuickAddButtonProps,
} from '@tomic/table';
import { Datatype, useResource, useTitle, type Property } from '@tomic/react';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import {
  isFormulaProperty,
  type DerivedColumnSpec,
  type DerivedValueKind,
} from './derivedColumns';
import { useFormulaReady, validateFormula } from './formulaEngine';

interface DerivedColumnDialogProps {
  open: boolean;
  bindShow: React.Dispatch<boolean>;
  /** Every property of the row class — the columns a formula can read. */
  classProperties: Property[];
  /** The spec being edited. Absent = creating a new column. */
  editing?: DerivedColumnSpec;
  onSave: (spec: DerivedColumnSpec) => TableViewWriteReceipt;
  scope: string;
  canSave?: boolean;
}

/**
 * Create or edit a computed column: a name and one formula. Columns are named in
 * the formula by the slug of their name (`Last watered` is `last_watered`).
 */
export function DerivedColumnDialog({
  open,
  bindShow,
  classProperties,
  editing,
  onSave,
  scope,
  canSave = true,
}: DerivedColumnDialogProps): JSX.Element {
  return (
    <TablePropertyDialog<ConfiguredColumnDialogDraft<DerivedColumnSpec>>
      open={open}
      scope={scope}
      canSave={canSave}
      title={editing ? 'Edit computed column' : 'New computed column'}
      Frame={ComputedFrame}
      Editor={AtomicDerivedColumnEditor}
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
        save: editing ? 'Save' : 'Add column',
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

function AtomicDerivedColumnEditor({
  draft,
  disabled,
  onValidationChange,
}: TablePropertyEditorProps<ConfiguredColumnDialogDraft<DerivedColumnSpec>>) {
  const classProperties = draft.properties;
  const ready = useFormulaReady();
  const examples: Array<{
    title: string;
    formula: string;
    valueKind?: DerivedValueKind;
  }> = [
    {
      title: 'Live duration',
      formula: 'coalesce(end, now()) - start',
      valueKind: 'duration',
    },
    { title: 'Time between', formula: 'end - start', valueKind: 'duration' },
    {
      title: 'Days since',
      formula: 'days(now() - last_contact)',
      valueKind: 'days',
    },
    { title: 'Total', formula: 'quantity * price' },
    {
      title: 'Next due',
      formula: 'addDays(last_done, every_days)',
      valueKind: 'date',
    },
    {
      title: 'Days until next birthday',
      formula: 'daysUntilAnniversary(birthday)',
    },
    {
      title: 'Birthday soon',
      formula: 'daysUntilAnniversary(birthday) <= 14',
      valueKind: 'boolean',
    },
  ];

  return (
    <TableDerivedColumnFields
      initial={draft.initial}
      disabled={disabled}
      ready={ready}
      validate={validateFormula}
      examples={examples}
      columns={classProperties.filter(isFormulaProperty).map(property => ({
        key: property.subject,
        label: property.shortname,
        instant: [Datatype.TIMESTAMP, Datatype.DATE].includes(
          property.datatype,
        ),
      }))}
      Input={FormulaInput}
      ExampleButton={ExampleButton}
      helper={identifiers =>
        `Combine columns with + - * / and functions: now(), coalesce(a, b), days(ms), addDays(date, n), daysUntilAnniversary(date), min, max, if(test, a, b). Dates are milliseconds, a missing value leaves the cell empty, and 1/2 is 0 (write 1.0/2). Columns you can use: ${identifiers.join(', ') || 'none yet'}.`
      }
      messages={{
        name: 'Name',
        formula: 'Formula',
        namePlaceholder: 'Duration',
        formulaPlaceholder: 'coalesce(end, now()) - start',
        unknown: (missing, suggestion) =>
          `There is no column "${missing}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
      }}
      onChange={(candidate, valid) => {
        draft.values.set('candidate', candidate);
        onValidationChange(valid);
      }}
    />
  );
}

function FormulaInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <InputWrapper>
      <InputStyled {...props} />
    </InputWrapper>
  );
}

function ExampleButton(props: TableQuickAddButtonProps) {
  return <Button {...props} subtle />;
}

/** Labels a column by its human title, the way the column menus do. */
export function PropertyOption({
  property,
}: {
  property: Property;
}): JSX.Element {
  const resource = useResource(property.subject);
  const [title] = useTitle(resource);

  return (
    <option value={property.subject}>{title || property.shortname}</option>
  );
}

function ComputedFrame(props: TablePropertyDialogPresentation) {
  return <AtomicPropertyFrame {...props} saveTestId='derived-save' />;
}
