import { Datatype, type Property } from '@tomic/react';
import type { JSX } from 'react';
import { styled } from 'styled-components';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { Checkbox } from '@components/forms/Checkbox';
import { PropertyOption } from './DerivedColumnDialog';
import {
  ROW_ACTION_GENERATORS,
  propertiesForRowAction,
  type RowActionKind,
} from './rowActions';
import { DEFAULT_QUICK_ADD_FIELD, type QuickAddSpec } from './quickAdd';

/**
 * The form's own state, flat and all-strings, because that is what inputs hold.
 * Kept separate from {@link QuickAddSpec} so a half-filled form is representable
 * without being a valid spec.
 */
export interface QuickAddDraft {
  label: string;
  /** Whether the button asks for a value before creating. */
  withField: boolean;
  field: string;
  placeholder: string;
  /** Empty when the button presets nothing. */
  presetKind: RowActionKind | '';
  presetProperty: string;
  presetValue: string;
}

export function draftFromSpec(spec: QuickAddSpec | undefined): QuickAddDraft {
  const preset = spec?.presets?.[0];

  return {
    label: spec?.label ?? '',
    // A new button defaults to asking for a name; an existing one is however it
    // was configured.
    withField: spec ? spec.field !== undefined : true,
    field: spec?.field ?? DEFAULT_QUICK_ADD_FIELD,
    placeholder: spec?.placeholder ?? '',
    presetKind: preset?.kind ?? '',
    presetProperty: preset?.property ?? '',
    presetValue: preset?.value === undefined ? '' : String(preset.value),
  };
}

export function specFromDraft(draft: QuickAddDraft): QuickAddSpec {
  const generator = draft.presetKind
    ? ROW_ACTION_GENERATORS[draft.presetKind]
    : undefined;
  const needsValue = generator?.valueInput !== undefined;

  return {
    label: draft.label.trim(),
    ...(draft.withField ? { field: draft.field } : {}),
    ...(draft.withField && draft.placeholder.trim()
      ? { placeholder: draft.placeholder.trim() }
      : {}),
    presets:
      draft.presetKind && draft.presetProperty
        ? [
            {
              kind: draft.presetKind,
              property: draft.presetProperty,
              ...(needsValue
                ? {
                    value:
                      generator?.valueInput === 'number'
                        ? Number(draft.presetValue)
                        : draft.presetValue,
                  }
                : {}),
            },
          ]
        : [],
  };
}

export function isQuickAddDraftComplete(draft: QuickAddDraft): boolean {
  return draft.label.trim() !== '';
}

interface Props {
  draft: QuickAddDraft;
  onChange: (draft: QuickAddDraft) => void;
  /** The row class's properties — what the field and the preset pick from. */
  classProperties: Property[];
}

/**
 * The fields that describe a create button, shared by the table's own dialog and
 * a dashboard block's. One implementation because it is one capability: the block
 * and the view store the identical shape.
 *
 * One preset rather than a list — the surveyed apps all wanted exactly one, and
 * the stored shape is already a list, so adding more needs no migration.
 */
export function QuickAddFields({
  draft,
  onChange,
  classProperties,
}: Props): JSX.Element {
  // Not a generic arrow: in a .tsx file esbuild parses `<K extends …>` as JSX and
  // refuses the module, even though tsc accepts it. A partial patch reads better
  // here anyway.
  const set = (patch: Partial<QuickAddDraft>) =>
    onChange({ ...draft, ...patch });

  const generator = draft.presetKind
    ? ROW_ACTION_GENERATORS[draft.presetKind]
    : undefined;
  const presetTargets = draft.presetKind
    ? propertiesForRowAction(classProperties, draft.presetKind)
    : [];
  const needsValue = generator?.valueInput !== undefined;
  // What is typed has to land somewhere that holds text; a name is the default.
  const fieldTargets = classProperties.filter(
    p =>
      p.subject === DEFAULT_QUICK_ADD_FIELD ||
      p.datatype === Datatype.STRING ||
      p.datatype === Datatype.SLUG,
  );

  return (
    <>
      <Field>
        <label htmlFor='quick-add-label'>Button says</label>
        <InputWrapper>
          <InputStyled
            id='quick-add-label'
            data-testid='quick-add-config-label'
            value={draft.label}
            placeholder='Log a feed'
            onChange={e => set({ label: e.target.value })}
          />
        </InputWrapper>
      </Field>

      <Field>
        <Toggle>
          <Checkbox
            checked={draft.withField}
            onChange={checked => set({ withField: checked })}
            data-testid='quick-add-config-with-field'
          />
          <span>Ask for a value first</span>
        </Toggle>
        <Hint>
          On for a list you name things in; off for a button you just press.
        </Hint>
      </Field>

      {draft.withField && (
        <>
          <Field>
            <label htmlFor='quick-add-field'>Type into</label>
            <StyledSelect
              id='quick-add-field'
              data-testid='quick-add-config-field'
              value={draft.field}
              onChange={e => set({ field: e.target.value })}
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
                value={draft.placeholder}
                placeholder={draft.label || 'What are you adding?'}
                onChange={e => set({ placeholder: e.target.value })}
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
          <option value=''>Nothing</option>
          {(Object.keys(ROW_ACTION_GENERATORS) as RowActionKind[]).map(kind => (
            <option key={kind} value={kind}>
              {ROW_ACTION_GENERATORS[kind].title}
            </option>
          ))}
        </StyledSelect>
        {draft.presetKind && <Hint>{generator?.description}</Hint>}
      </Field>

      {draft.presetKind && (
        <Field>
          <label htmlFor='quick-add-preset-property'>On column</label>
          <StyledSelect
            id='quick-add-preset-property'
            data-testid='quick-add-config-preset-property'
            value={draft.presetProperty}
            onChange={e => set({ presetProperty: e.target.value })}
          >
            <option value=''>Pick a column…</option>
            {presetTargets.map(p => (
              <PropertyOption key={p.subject} property={p} />
            ))}
          </StyledSelect>
        </Field>
      )}

      {draft.presetKind && needsValue && (
        <Field>
          <label htmlFor='quick-add-preset-value'>
            {generator?.valueLabel ?? 'Value'}
          </label>
          <InputWrapper>
            <InputStyled
              id='quick-add-preset-value'
              data-testid='quick-add-config-preset-value'
              type={generator?.valueInput === 'number' ? 'number' : 'text'}
              value={draft.presetValue}
              onChange={e => set({ presetValue: e.target.value })}
            />
          </InputWrapper>
        </Field>
      )}
    </>
  );
}

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
