import { core, useResource, useString, type Property } from '@tomic/react';
import {
  useCallback,
  useEffect,
  useState,
  type InputHTMLAttributes,
  type JSX,
} from 'react';
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
  const [state, setState] = useState<{
    draft: RowActionSpec;
    valid: boolean;
  }>();
  const clear = useCallback(() => setState(undefined), []);
  const [dialogProps, show, hide, isOpen] = useDialog({
    bindShow,
    onCancel: clear,
    onSuccess: clear,
  });
  useEffect(() => {
    if (open) show();
  }, [open, show]);
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
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h2>{editing ? 'Edit action' : 'Add an action'}</h2>
      </DialogTitle>
      <DialogContent>
        {isOpen && (
          <TableRowActionFields
            initial={editing}
            kinds={kinds}
            Input={ActionInput}
            onChange={(draft, valid) => setState({ draft, valid })}
            messages={{
              kind: 'Does what',
              property: 'To column',
              pickProperty: 'Pick a column…',
              pickOption: 'Pick an option…',
              label: 'Button says',
              noTargets:
                'This table has no column of the right kind for that yet.',
              invalidNumber: 'Enter a finite number.',
            }}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={() => hide()}>
          Cancel
        </Button>
        <Button
          data-testid='action-config-save'
          disabled={!state?.valid}
          onClick={() => {
            if (!state?.valid) return;
            onSave(state.draft);
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
