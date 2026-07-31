import { Datatype, type Property } from '@tomic/react';
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
import { Checkbox } from '@components/forms/Checkbox';
import { PropertyOption } from './DerivedColumnDialog';
import {
  ROW_ACTION_GENERATORS,
  propertiesForRowAction,
  type RowActionKind,
} from './rowActions';
import { DEFAULT_QUICK_ADD_FIELD, type QuickAddSpec } from './quickAdd';

interface Props {
  open: boolean;
  bindShow: (show: boolean) => void;
  classProperties: Property[];
  /** The spec being edited, if the view already has one. */
  editing?: QuickAddSpec;
  onSave: (spec: QuickAddSpec | undefined) => void;
}

/**
 * Configures the view's quick-add button.
 *
 * One preset is offered rather than a list: the surveyed apps all wanted exactly
 * one ("stamp the time", "start it un-bought"), and a repeatable row editor here
 * would cost more than the second preset is worth. The stored shape is a list, so
 * adding that later needs no migration.
 */
export function QuickAddDialog({
  open,
  bindShow,
  classProperties,
  editing,
  onSave,
}: Props): JSX.Element {
  const [dialogProps, show, hide, isOpen] = useDialog({ bindShow });

  const [label, setLabel] = useState('');
  const [withField, setWithField] = useState(true);
  const [field, setField] = useState<string>(DEFAULT_QUICK_ADD_FIELD);
  const [placeholder, setPlaceholder] = useState('');
  const [presetKind, setPresetKind] = useState<RowActionKind | ''>('');
  const [presetProperty, setPresetProperty] = useState('');
  const [presetValue, setPresetValue] = useState('');

  useEffect(() => {
    if (open) {
      show();
    }
  }, [open, show]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const preset = editing?.presets?.[0];

    setLabel(editing?.label ?? '');
    setWithField(editing ? editing.field !== undefined : true);
    setField(editing?.field ?? DEFAULT_QUICK_ADD_FIELD);
    setPlaceholder(editing?.placeholder ?? '');
    setPresetKind(preset?.kind ?? '');
    setPresetProperty(preset?.property ?? '');
    setPresetValue(preset?.value === undefined ? '' : String(preset.value));
    // Only on open — see the row-action dialog for why.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const generator = presetKind ? ROW_ACTION_GENERATORS[presetKind] : undefined;
  const presetTargets = presetKind
    ? propertiesForRowAction(classProperties, presetKind)
    : [];
  const needsValue = generator?.valueInput !== undefined;
  // Text-ish columns can hold what is typed; a name is the obvious default.
  const fieldTargets = classProperties.filter(
    p =>
      p.subject === DEFAULT_QUICK_ADD_FIELD ||
      p.datatype === Datatype.STRING ||
      p.datatype === Datatype.SLUG,
  );

  const save = () => {
    const spec: QuickAddSpec = {
      label: label.trim(),
      ...(withField ? { field } : {}),
      ...(withField && placeholder.trim()
        ? { placeholder: placeholder.trim() }
        : {}),
      presets:
        presetKind && presetProperty
          ? [
              {
                kind: presetKind,
                property: presetProperty,
                ...(needsValue
                  ? {
                      value:
                        generator?.valueInput === 'number'
                          ? Number(presetValue)
                          : presetValue,
                    }
                  : {}),
              },
            ]
          : [],
    };

    onSave(spec);
    hide();
  };

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h2>{editing ? 'Edit the add button' : 'Add a create button'}</h2>
      </DialogTitle>
      <DialogContent>
        <Fields>
          <Field>
            <label htmlFor='quick-add-label'>Button says</label>
            <InputWrapper>
              <InputStyled
                id='quick-add-label'
                data-testid='quick-add-config-label'
                value={label}
                placeholder='Log a feed'
                onChange={e => setLabel(e.target.value)}
              />
            </InputWrapper>
            <Hint>
              It sits above the rows and creates one. Everything else about the
              row is edited in the table.
            </Hint>
          </Field>

          <Field>
            <Toggle>
              <Checkbox
                checked={withField}
                onChange={setWithField}
                data-testid='quick-add-config-with-field'
              />
              <span>Ask for a value first</span>
            </Toggle>
            <Hint>
              On for a list you name things in; off for a button you just press.
            </Hint>
          </Field>

          {withField && (
            <>
              <Field>
                <label htmlFor='quick-add-field'>Type into</label>
                <StyledSelect
                  id='quick-add-field'
                  data-testid='quick-add-config-field'
                  value={field}
                  onChange={e => setField(e.target.value)}
                >
                  {fieldTargets.map(p => (
                    <PropertyOption key={p.subject} property={p} />
                  ))}
                </StyledSelect>
              </Field>
              <Field>
                <label htmlFor='quick-add-placeholder'>Placeholder</label>
                <InputWrapper>
                  <InputStyled
                    id='quick-add-placeholder'
                    data-testid='quick-add-config-placeholder'
                    value={placeholder}
                    placeholder={label || 'What are you adding?'}
                    onChange={e => setPlaceholder(e.target.value)}
                  />
                </InputWrapper>
              </Field>
            </>
          )}

          <Field>
            <label htmlFor='quick-add-preset-kind'>Also set</label>
            <StyledSelect
              id='quick-add-preset-kind'
              data-testid='quick-add-config-preset'
              value={presetKind}
              onChange={e => {
                setPresetKind(e.target.value as RowActionKind | '');
                setPresetProperty('');
                setPresetValue('');
              }}
            >
              <option value=''>Nothing</option>
              {(Object.keys(ROW_ACTION_GENERATORS) as RowActionKind[]).map(
                kind => (
                  <option key={kind} value={kind}>
                    {ROW_ACTION_GENERATORS[kind].title}
                  </option>
                ),
              )}
            </StyledSelect>
            {presetKind && <Hint>{generator?.description}</Hint>}
          </Field>

          {presetKind && (
            <Field>
              <label htmlFor='quick-add-preset-property'>On column</label>
              <StyledSelect
                id='quick-add-preset-property'
                data-testid='quick-add-config-preset-property'
                value={presetProperty}
                onChange={e => setPresetProperty(e.target.value)}
              >
                <option value=''>Pick a column…</option>
                {presetTargets.map(p => (
                  <PropertyOption key={p.subject} property={p} />
                ))}
              </StyledSelect>
            </Field>
          )}

          {presetKind && needsValue && (
            <Field>
              <label htmlFor='quick-add-preset-value'>
                {generator?.valueLabel ?? 'Value'}
              </label>
              <InputWrapper>
                <InputStyled
                  id='quick-add-preset-value'
                  data-testid='quick-add-config-preset-value'
                  type={generator?.valueInput === 'number' ? 'number' : 'text'}
                  value={presetValue}
                  onChange={e => setPresetValue(e.target.value)}
                />
              </InputWrapper>
            </Field>
          )}
        </Fields>
      </DialogContent>
      <DialogActions>
        {editing && (
          <Button
            subtle
            data-testid='quick-add-config-remove'
            onClick={() => {
              onSave(undefined);
              hide();
            }}
          >
            Remove
          </Button>
        )}
        <Button subtle onClick={() => hide()}>
          Cancel
        </Button>
        <Button
          data-testid='quick-add-config-save'
          disabled={label.trim() === ''}
          onClick={save}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
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

const Toggle = styled.label`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
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
