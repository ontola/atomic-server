import { useId, type ComponentType, type InputHTMLAttributes } from 'react';
import { styled } from 'styled-components';
import type {
  QuickAddSpec,
  QuickAddPreset,
  RowActionKind,
} from './views/configuration.js';
import type {
  TableRowActionKind,
  TableRowActionTarget,
} from './RowActionFields.js';
import { tableTheme } from './theme.js';

/** Raw strings retain unfinished input until validation succeeds. */
export interface QuickAddDraft {
  label: string;
  withField: boolean;
  field: string;
  placeholder: string;
  presetKind: RowActionKind | '';
  presetProperty: string;
  presetValue: string;
  /** The single-preset editor must not silently drop additional stored presets. */
  remainingPresets?: QuickAddPreset[];
}
export function quickAddDraftFromSpec(
  spec: QuickAddSpec | undefined,
  defaultField: string,
): QuickAddDraft {
  const preset = spec?.presets?.[0];

  return {
    label: spec?.label ?? '',
    withField: spec ? spec.field !== undefined : true,
    field: spec?.field ?? defaultField,
    placeholder: spec?.placeholder ?? '',
    presetKind: preset?.kind ?? '',
    presetProperty: preset?.property ?? '',
    presetValue: preset?.value === undefined ? '' : String(preset.value),
    remainingPresets: structuredClone(spec?.presets?.slice(1) ?? []),
  };
}

function presetIsValid(
  draft: QuickAddDraft,
  kinds: readonly TableRowActionKind[],
) {
  if (!draft.presetKind) return true;
  const kind = kinds.find(item => item.kind === draft.presetKind);
  const target = kind?.targets.find(item => item.key === draft.presetProperty);
  if (!kind || !target) return false;
  if (
    target.values?.length &&
    !target.values.some(item => item.key === draft.presetValue)
  )
    return false;
  if (!kind.valueField) return true;
  if (kind.valueField.input !== 'number') return draft.presetValue !== '';

  return (
    !!draft.presetValue.trim() &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
      draft.presetValue.trim(),
    ) &&
    Number.isFinite(Number(draft.presetValue))
  );
}

export function isQuickAddDraftComplete(
  draft: QuickAddDraft,
  kinds: readonly TableRowActionKind[],
  fields: readonly TableRowActionTarget[],
): boolean {
  return (
    !!draft.label.trim() &&
    (!draft.withField || fields.some(field => field.key === draft.field)) &&
    presetIsValid(draft, kinds)
  );
}
export function quickAddSpecFromDraft(
  draft: QuickAddDraft,
  kinds: readonly TableRowActionKind[],
  fields: readonly TableRowActionTarget[],
): QuickAddSpec {
  if (!isQuickAddDraftComplete(draft, kinds, fields))
    throw Error('Complete the create-button configuration before saving.');
  const generator = kinds.find(kind => kind.kind === draft.presetKind);
  const first: QuickAddPreset[] = draft.presetKind
    ? [
        {
          kind: draft.presetKind,
          property: draft.presetProperty,
          ...(generator?.valueField
            ? {
                value:
                  generator.valueField.input === 'number'
                    ? Number(draft.presetValue)
                    : draft.presetValue,
              }
            : {}),
        },
      ]
    : [];

  return {
    label: draft.label.trim(),
    ...(draft.withField ? { field: draft.field } : {}),
    ...(draft.withField && draft.placeholder.trim()
      ? { placeholder: draft.placeholder.trim() }
      : {}),
    presets: [...first, ...structuredClone(draft.remainingPresets ?? [])],
  };
}
export interface TableQuickAddFieldsProps {
  draft: QuickAddDraft;
  onChange: (draft: QuickAddDraft) => void;
  kinds: readonly TableRowActionKind[];
  fields: readonly TableRowActionTarget[];
  disabled?: boolean;
  Input?: ComponentType<InputHTMLAttributes<HTMLInputElement>>;
  Checkbox?: ComponentType<{
    checked: boolean;
    onChange: (checked: boolean) => void;
    'data-testid'?: string;
  }>;
  messages?: Partial<{
    label: string;
    withField: string;
    field: string;
    placeholder: string;
    preset: string;
    property: string;
    nothing: string;
    pickProperty: string;
    pickOption: string;
    labelPlaceholder: string;
    fieldPlaceholder: string;
    fieldHint: string;
    value: string;
    invalidPreset: string;
    additionalPresets: string;
  }>;
}
/** Actual create-button fields shared by table and dashboard configuration. */
export function TableQuickAddFields({
  draft,
  onChange,
  kinds,
  fields,
  disabled,
  Input = DefaultInput,
  Checkbox = DefaultCheckbox,
  messages,
}: TableQuickAddFieldsProps) {
  const id = useId();
  const set = (patch: Partial<QuickAddDraft>) =>
    onChange({ ...draft, ...patch });
  const generator = kinds.find(kind => kind.kind === draft.presetKind);
  const presetTarget = generator?.targets.find(
    target => target.key === draft.presetProperty,
  );
  const needsValue = generator?.valueField !== undefined;
  const presetValid = presetIsValid(draft, kinds);
  const text = {
    label: 'Button says',
    withField: 'Ask for a value first',
    field: 'Type into',
    placeholder: 'Placeholder',
    preset: 'Also set',
    property: 'On column',
    nothing: 'Nothing',
    pickProperty: 'Pick a column…',
    pickOption: 'Pick an option…',
    labelPlaceholder: 'Log a feed',
    fieldPlaceholder: 'What are you adding?',
    fieldHint:
      'On for a list you name things in; off for a button you just press.',
    value: 'Value',
    invalidPreset: 'Choose a compatible column and a valid preset value.',
    additionalPresets:
      'Additional stored presets are retained. This form edits the first preset.',
    ...messages,
  };

  return (
    <Fields disabled={disabled}>
      {!!draft.remainingPresets?.length && (
        <Hint>{text.additionalPresets}</Hint>
      )}
      <Field>
        <label htmlFor={`${id}-quick-add-label`}>{text.label}</label>
        <>
          <Input
            id={`${id}-quick-add-label`}
            data-testid='quick-add-config-label'
            value={draft.label}
            placeholder={text.labelPlaceholder}
            onChange={e => set({ label: e.target.value })}
          />
        </>
      </Field>

      <Field>
        <Toggle>
          <Checkbox
            checked={draft.withField}
            onChange={checked => set({ withField: checked })}
            data-testid='quick-add-config-with-field'
          />
          <span>{text.withField}</span>
        </Toggle>
        <Hint>{text.fieldHint}</Hint>
      </Field>

      {draft.withField && (
        <>
          <Field>
            <label htmlFor={`${id}-quick-add-field`}>{text.field}</label>
            <StyledSelect
              id={`${id}-quick-add-field`}
              data-testid='quick-add-config-field'
              value={draft.field}
              onChange={e => set({ field: e.target.value })}
            >
              {fields.map(target => target.option)}
            </StyledSelect>
          </Field>
          <Field>
            <label htmlFor={`${id}-quick-add-placeholder`}>
              {text.placeholder}
            </label>
            <>
              <Input
                id={`${id}-quick-add-placeholder`}
                data-testid='quick-add-config-placeholder'
                value={draft.placeholder}
                placeholder={draft.label || text.fieldPlaceholder}
                onChange={e => set({ placeholder: e.target.value })}
              />
            </>
          </Field>
        </>
      )}

      <Field>
        <label htmlFor={`${id}-quick-add-preset-kind`}>{text.preset}</label>
        <StyledSelect
          id={`${id}-quick-add-preset-kind`}
          data-testid='quick-add-config-preset'
          value={draft.presetKind}
          onChange={e =>
            onChange({
              ...draft,
              presetKind: e.target.value as RowActionKind | '',
              // The target and the literal belong to the previous verb.
              presetProperty: '',
              presetValue: '',
            })
          }
        >
          <option value=''>{text.nothing}</option>
          {kinds.map(option => (
            <option key={option.kind} value={option.kind}>
              {option.title}
            </option>
          ))}
        </StyledSelect>
        {draft.presetKind && <Hint>{generator?.description}</Hint>}
      </Field>

      {draft.presetKind && (
        <Field>
          <label htmlFor={`${id}-quick-add-preset-property`}>
            {text.property}
          </label>
          <StyledSelect
            id={`${id}-quick-add-preset-property`}
            data-testid='quick-add-config-preset-property'
            value={draft.presetProperty}
            onChange={e =>
              set({ presetProperty: e.target.value, presetValue: '' })
            }
          >
            <option value=''>{text.pickProperty}</option>
            {generator?.targets.map(target => target.option)}
          </StyledSelect>
        </Field>
      )}

      {draft.presetKind && needsValue && (
        <Field>
          <label htmlFor={`${id}-quick-add-preset-value`}>
            {generator?.valueField?.label ?? text.value}
          </label>
          {/* A select column's options are its own tags, so offer those rather
           *  than asking for a subject to be typed. */}
          {presetTarget?.values?.length ? (
            <StyledSelect
              id={`${id}-quick-add-preset-value`}
              data-testid='quick-add-config-preset-value'
              value={draft.presetValue}
              onChange={e => set({ presetValue: e.target.value })}
            >
              <option value=''>{text.pickOption}</option>
              {presetTarget.values.map(option => option.option)}
            </StyledSelect>
          ) : (
            <>
              <Input
                id={`${id}-quick-add-preset-value`}
                data-testid='quick-add-config-preset-value'
                type='text'
                inputMode={
                  generator?.valueField?.input === 'number'
                    ? 'decimal'
                    : undefined
                }
                aria-invalid={!presetValid}
                value={draft.presetValue}
                onChange={e => set({ presetValue: e.target.value })}
              />
            </>
          )}
        </Field>
      )}
      {!presetValid && <Hint role='alert'>{text.invalidPreset}</Hint>}
    </Fields>
  );
}

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;

  label {
    font-size: 0.85rem;
    color: ${p => tableTheme(p.theme).colors.textLight};
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
  color: ${p => tableTheme(p.theme).colors.textLight};
`;

const StyledSelect = styled.select`
  padding: 0.4rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  background-color: ${p => tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
`;

const Fields = styled.fieldset`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 0;
  margin: 0;
  border: 0;
`;
const DefaultInput = styled.input`
  padding: 0.4rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  background: ${p => tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
`;

function DefaultCheckbox({
  checked,
  onChange,
  ...props
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  'data-testid'?: string;
}) {
  return (
    <input
      type='checkbox'
      checked={checked}
      onChange={event => onChange(event.target.checked)}
      {...props}
    />
  );
}
