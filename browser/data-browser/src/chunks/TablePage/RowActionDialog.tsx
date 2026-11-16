import { core, useResource, useString, type Property } from '@tomic/react';
import { useEffect, useState, type JSX, type InputHTMLAttributes } from 'react';
import { TableRowActionFields } from '@tomic/table';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { Button } from '@components/Button';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { PropertyOption } from './DerivedColumnDialog';
import {
  ROW_ACTION_GENERATORS,
  ROW_ACTION_KINDS,
  isRowActionComplete,
  propertiesForRowAction,
  rowActionValueInput,
  type RowActionKind,
  type RowActionSpec,
} from './rowActions';

interface Props {
  open: boolean;
  bindShow: (show: boolean) => void;
  classProperties: Property[];
  /** Set when editing; absent when adding. */
  editing?: RowActionSpec;
  onSave: (spec: RowActionSpec) => void;
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

  const draft: RowActionSpec = {
    id: editing?.id ?? '',
    label: label || generator.defaultLabel,
    kind,
    property,
    ...(valueField
      ? {
          value:
            valueField.input === 'number' ? Number(value) : (value as string),
        }
      : {}),
  };

  const complete = isRowActionComplete(draft) && !!property;

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h2>{editing ? 'Edit action' : 'Add an action'}</h2>
      </DialogTitle>
      <DialogContent>
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
          Input={ActionInput}
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
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={() => hide()}>
          Cancel
        </Button>
        <Button
          data-testid='action-config-save'
          disabled={!complete}
          onClick={() => {
            onSave(draft);
            hide();
          }}
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

function ActionInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <InputWrapper>
      <InputStyled {...props} />
    </InputWrapper>
  );
}
