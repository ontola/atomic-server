import {
  useCallback,
  useEffect,
  useState,
  type InputHTMLAttributes,
  type JSX,
} from 'react';
import {
  TableDerivedColumnFields,
  type TableQuickAddButtonProps,
} from '@tomic/table';
import { Datatype, useResource, useTitle, type Property } from '@tomic/react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { Button } from '@components/Button';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { stringToSlug } from '@helpers/stringToSlug';
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
  onSave: (spec: DerivedColumnSpec) => void;
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
}: DerivedColumnDialogProps): JSX.Element {
  const [state, setState] = useState<{
    draft: DerivedColumnSpec;
    valid: boolean;
  }>();
  const clear = useCallback(() => setState(undefined), []);
  const [dialogProps, show, hide, isOpen] = useDialog({
    bindShow,
    onCancel: clear,
    onSuccess: clear,
  });
  const ready = useFormulaReady();
  useEffect(() => {
    if (open) show();
  }, [open, show]);
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

  if (!open) return <></>;

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h1>{editing ? 'Edit computed column' : 'New computed column'}</h1>
      </DialogTitle>
      <DialogContent>
        {isOpen && (
          <TableDerivedColumnFields
            initial={editing}
            ready={ready}
            validate={validateFormula}
            examples={examples}
            columns={classProperties
              .filter(isFormulaProperty)
              .map(property => ({
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
            onChange={(draft, valid) => setState({ draft, valid })}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={() => hide()}>
          Cancel
        </Button>
        <Button
          disabled={!state?.valid}
          data-testid='derived-save'
          onClick={() => {
            if (!state?.valid) return;
            onSave({
              ...state.draft,
              id: state.draft.id || stringToSlug(state.draft.label),
            });
            hide();
          }}
        >
          {editing ? 'Save' : 'Add column'}
        </Button>
      </DialogActions>
    </Dialog>
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
