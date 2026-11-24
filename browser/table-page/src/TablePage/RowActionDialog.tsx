import {
  core,
  Datatype,
  useResource,
  useString,
  type Property,
} from '@tomic/react';
import { useEffect, useState, type JSX } from 'react';
import { TableRowActionFields } from '@tomic/table';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@tomic/resource-ui/components/Dialog/index';
import { Button } from '@tomic/ui/components/Button';
import { ErrorChip } from '@tomic/resource-ui/components/forms/ErrorChip';
import { useDialogSave } from './helpers/useDialogSave.js';
import { parseFloatText, parseInteger } from './EditorCells/numberInput.js';
import { PropertyOption } from './DerivedColumnDialog.js';
import {
  ROW_ACTION_GENERATORS,
  ROW_ACTION_KINDS,
  isRowActionComplete,
  propertiesForRowAction,
  rowActionValueInput,
  type RowActionKind,
  type RowActionSpec,
} from './rowActions.js';

interface Props {
  open: boolean;
  bindShow: (show: boolean) => void;
  classProperties: Property[];
  /** Set when editing; absent when adding. */
  editing?: RowActionSpec;
  onSave: (spec: RowActionSpec) => void | Promise<void>;
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
}: Props): JSX.Element {
  const [dialogProps, show, hide, isOpen] = useDialog({ bindShow });
  const { busy, error, clearError, submit, cancel } = useDialogSave(hide);
  const [draftId, setDraftId] = useState('');

  const [kind, setKind] = useState<RowActionKind>('setNow');
  const [label, setLabel] = useState('');
  const [property, setProperty] = useState('');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (open) {
      show();
    }
  }, [open, show]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setDraftId(editing?.id ?? crypto.randomUUID());
    clearError();
    setKind(editing?.kind ?? 'setNow');
    setLabel(editing?.label ?? '');
    setProperty(editing?.property ?? '');
    setValue(editing?.value === undefined ? '' : String(editing.value));
    // Only on open: re-syncing while the dialog is up would overwrite what is
    // being typed every time a commit lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const generator = ROW_ACTION_GENERATORS[kind];
  const valueField = rowActionValueInput(kind);
  const target = classProperties.find(p => p.subject === property);

  const kinds = ROW_ACTION_KINDS.map(actionKind => ({
    kind: actionKind,
    title: ROW_ACTION_GENERATORS[actionKind].title,
    description: ROW_ACTION_GENERATORS[actionKind].description,
    defaultLabel: ROW_ACTION_GENERATORS[actionKind].defaultLabel,
    valueField: rowActionValueInput(actionKind),
    targets: propertiesForRowAction(classProperties, actionKind).map(
      candidate => ({
        key: candidate.subject,
        option: <PropertyOption key={candidate.subject} property={candidate} />,
        values: candidate.allowsOnly?.map(tag => ({
          key: tag,
          option: <TagOption key={tag} subject={tag} />,
        })),
      }),
    ),
  }));

  const numeric =
    valueField?.input === 'number' ||
    target?.datatype === Datatype.INTEGER ||
    target?.datatype === Datatype.FLOAT;
  const parseNumber =
    target?.datatype === Datatype.INTEGER ? parseInteger : parseFloatText;
  const literal = numeric ? parseNumber(value) : value;
  const draft: RowActionSpec = {
    id: draftId,
    label: label || generator.defaultLabel,
    kind,
    property,
    ...(valueField && typeof literal !== 'symbol' ? { value: literal } : {}),
  };

  const complete =
    !!target &&
    generator.accepts(target) &&
    isRowActionComplete(draft) &&
    (valueField?.input !== 'select' ||
      !target.allowsOnly?.length ||
      target.allowsOnly.includes(value));

  return (
    <Dialog
      {...dialogProps}
      aria-busy={busy}
      disableLightDismiss={busy}
      onClose={cancel}
    >
      <DialogTitle>
        <h2>{editing ? 'Edit action' : 'Add an action'}</h2>
      </DialogTitle>
      <DialogContent inert={busy}>
        <TableRowActionFields
          kinds={kinds}
          kind={kind}
          property={property}
          label={label}
          value={value}
          values={
            target?.allowsOnly?.map(tag => ({
              key: tag,
              option: <TagOption key={tag} subject={tag} />,
            })) ?? []
          }
          onKindChange={next => {
            setKind(next);
            setProperty('');
            setValue('');
          }}
          onPropertyChange={next => {
            setProperty(next);
            setValue('');
          }}
          onValueChange={setValue}
          onLabelChange={setLabel}
          messages={{
            kind: 'Does what',
            property: 'To column',
            pickProperty: 'Pick a column…',
            pickOption: 'Pick an option…',
            label: 'Button says',
            noTargets:
              'This table has no column of the right kind for that yet.',
          }}
        />
        {error && <ErrorChip role='alert'>{error}</ErrorChip>}
      </DialogContent>
      <DialogActions>
        <Button subtle disabled={busy} onClick={cancel}>
          Cancel
        </Button>
        <Button
          data-testid='action-config-save'
          disabled={busy || !complete}
          onClick={() => submit(() => onSave(draft))}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** A tag's name, for the value picker of a select column. */
export function TagOption({ subject }: { subject: string }): JSX.Element {
  const tag = useResource(subject);
  const [shortname] = useString(tag, core.properties.shortname);

  return <option value={subject}>{shortname ?? tag.title}</option>;
}
