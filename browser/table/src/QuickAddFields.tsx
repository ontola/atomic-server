import {
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
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

/** The existing flat string draft for the create-button form. */
export interface QuickAddDraft {
  label: string;
  withField: boolean;
  field: string;
  placeholder: string;
  presetKind: RowActionKind | '';
  presetProperty: string;
  presetValue: string;
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
  };
}

export function isQuickAddDraftComplete(draft: QuickAddDraft): boolean {
  return draft.label.trim() !== '';
}
export function quickAddSpecFromDraft(
  draft: QuickAddDraft,
  kinds: readonly TableRowActionKind[],
): QuickAddSpec {
  const generator = kinds.find(kind => kind.kind === draft.presetKind);
  const first: QuickAddPreset[] =
    draft.presetKind && draft.presetProperty
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
    presets: first,
  };
}
export interface TableQuickAddFieldsProps {
  draft: QuickAddDraft;
  onChange: (draft: QuickAddDraft) => void;
  kinds: readonly TableRowActionKind[];
  fields: readonly TableRowActionTarget[];
  presetValues: readonly { key: string; option: ReactNode }[];
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
  }>;
}
/** Actual create-button fields shared by table and dashboard configuration. */
export function TableQuickAddFields({
  draft,
  onChange,
  kinds,
  fields,
  presetValues,
  Input = DefaultInput,
  Checkbox = DefaultCheckbox,
  messages,
}: TableQuickAddFieldsProps) {
  const set = (patch: Partial<QuickAddDraft>) =>
    onChange({ ...draft, ...patch });
  const generator = kinds.find(kind => kind.kind === draft.presetKind);
  const presetTarget = { values: presetValues };
  const needsValue = generator?.valueField !== undefined;
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
    ...messages,
  };

  return (
    <>
      <Field>
        <label htmlFor={'quick-add-label'}>{text.label}</label>
        <>
          <Input
            id={'quick-add-label'}
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
            <label htmlFor={'quick-add-field'}>{text.field}</label>
            <StyledSelect
              id={'quick-add-field'}
              data-testid='quick-add-config-field'
              value={draft.field}
              onChange={e => set({ field: e.target.value })}
            >
              {fields.map(target => target.option)}
            </StyledSelect>
          </Field>
          <Field>
            <label htmlFor={'quick-add-placeholder'}>{text.placeholder}</label>
            <>
              <Input
                id={'quick-add-placeholder'}
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
        <label htmlFor={'quick-add-preset-kind'}>{text.preset}</label>
        <StyledSelect
          id={'quick-add-preset-kind'}
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
          <label htmlFor={'quick-add-preset-property'}>{text.property}</label>
          <StyledSelect
            id={'quick-add-preset-property'}
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
          <label htmlFor={'quick-add-preset-value'}>
            {generator?.valueField?.label ?? text.value}
          </label>
          {/* A select column's options are its own tags, so offer those rather
           *  than asking for a subject to be typed. */}
          {presetTarget?.values?.length ? (
            <StyledSelect
              id={'quick-add-preset-value'}
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
                id={'quick-add-preset-value'}
                data-testid='quick-add-config-preset-value'
                type={
                  generator?.valueField?.input === 'number' ? 'number' : 'text'
                }
                value={draft.presetValue}
                onChange={e => set({ presetValue: e.target.value })}
              />
            </>
          )}
        </Field>
      )}
    </>
  );
}

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => tableTheme(p.theme).size(1)};

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
