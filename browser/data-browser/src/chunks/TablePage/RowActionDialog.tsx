import { core, useResource, useString, type Property } from '@tomic/react';
import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
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
  const targets = propertiesForRowAction(classProperties, kind);
  const valueField = rowActionValueInput(kind);
  const target = classProperties.find(p => p.subject === property);

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
        <Fields>
          <Field>
            <label htmlFor='row-action-kind'>Does what</label>
            <StyledSelect
              id='row-action-kind'
              data-testid='action-config-kind'
              value={kind}
              onChange={e => {
                const next = e.target.value as RowActionKind;
                setKind(next);
                // The target and the literal both belong to the previous verb —
                // a step of 1 means nothing to "mark done".
                setProperty('');
                setValue('');
              }}
            >
              {ROW_ACTION_KINDS.map(k => (
                <option key={k} value={k}>
                  {ROW_ACTION_GENERATORS[k].title}
                </option>
              ))}
            </StyledSelect>
            <Hint>{generator.description}</Hint>
          </Field>

          <Field>
            <label htmlFor='row-action-property'>To column</label>
            <StyledSelect
              id='row-action-property'
              data-testid='action-config-property'
              value={property}
              onChange={e => {
                setProperty(e.target.value);
                setValue('');
              }}
            >
              <option value=''>Pick a column…</option>
              {/* Labelled by human title, the same as the computed-column
               *  dialog and the column menus. */}
              {targets.map(p => (
                <PropertyOption key={p.subject} property={p} />
              ))}
            </StyledSelect>
            {targets.length === 0 && (
              <Hint>
                This table has no column of the right kind for that yet.
              </Hint>
            )}
          </Field>

          {valueField && (
            <Field>
              <label htmlFor='row-action-value'>{valueField.label}</label>
              {/* A select column's options are its own tags, so offer those
               *  rather than asking for a subject to be typed. */}
              {target && target.allowsOnly?.length ? (
                <StyledSelect
                  id='row-action-value'
                  data-testid='action-config-value'
                  value={value}
                  onChange={e => setValue(e.target.value)}
                >
                  <option value=''>Pick an option…</option>
                  {target.allowsOnly.map(tag => (
                    <TagOption key={tag} subject={tag} />
                  ))}
                </StyledSelect>
              ) : (
                <InputWrapper>
                  <InputStyled
                    id='row-action-value'
                    data-testid='action-config-value'
                    type={valueField.input === 'number' ? 'number' : 'text'}
                    value={value}
                    onChange={e => setValue(e.target.value)}
                  />
                </InputWrapper>
              )}
            </Field>
          )}

          <Field>
            <label htmlFor='row-action-label'>Button says</label>
            <InputWrapper>
              <InputStyled
                id='row-action-label'
                data-testid='action-config-label'
                value={label}
                placeholder={generator.defaultLabel}
                onChange={e => setLabel(e.target.value)}
              />
            </InputWrapper>
          </Field>
        </Fields>
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
function TagOption({ subject }: { subject: string }): JSX.Element {
  const tag = useResource(subject);
  const [shortname] = useString(tag, core.properties.shortname);

  return <option value={subject}>{shortname ?? tag.title}</option>;
}

const Fields = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(2)};
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(1)};

  label {
    font-size: 0.85rem;
    color: ${p => p.theme.colors.textLight};
  }
`;

const Hint = styled.span`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const StyledSelect = styled.select`
  padding: 0.4rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
`;
