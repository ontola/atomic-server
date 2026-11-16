import { Datatype, type Property } from '@tomic/react';
import {
  TableQuickAddFields,
  quickAddDraftFromSpec,
  quickAddSpecFromDraft,
  isQuickAddDraftComplete as complete,
  type QuickAddDraft,
} from '@tomic/table';
import type { InputHTMLAttributes } from 'react';
import { Checkbox } from '@components/forms/Checkbox';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { PropertyOption } from './DerivedColumnDialog';
import { TagOption } from './RowActionDialog';
import {
  ROW_ACTION_GENERATORS,
  ROW_ACTION_KINDS,
  propertiesForRowAction,
  rowActionValueInput,
} from './rowActions';
import { DEFAULT_QUICK_ADD_FIELD, type QuickAddSpec } from './quickAdd';

export type { QuickAddDraft } from '@tomic/table';

function options(properties: Property[]) {
  return {
    kinds: ROW_ACTION_KINDS.map(kind => ({
      kind,
      title: ROW_ACTION_GENERATORS[kind].title,
      description: ROW_ACTION_GENERATORS[kind].description,
      defaultLabel: ROW_ACTION_GENERATORS[kind].defaultLabel,
      valueField: rowActionValueInput(kind),
      targets: propertiesForRowAction(properties, kind).map(property => ({
        key: property.subject,
        option: <PropertyOption key={property.subject} property={property} />,
        values: property.allowsOnly?.map(tag => ({
          key: tag,
          option: <TagOption key={tag} subject={tag} />,
        })),
      })),
    })),
    fields: properties
      .filter(
        property =>
          property.subject === DEFAULT_QUICK_ADD_FIELD ||
          property.datatype === Datatype.STRING ||
          property.datatype === Datatype.SLUG,
      )
      .map(property => ({
        key: property.subject,
        option: <PropertyOption key={property.subject} property={property} />,
      })),
  };
}

export function draftFromSpec(spec: QuickAddSpec | undefined): QuickAddDraft {
  return quickAddDraftFromSpec(spec, DEFAULT_QUICK_ADD_FIELD);
}
export function specFromDraft(
  draft: QuickAddDraft,
  properties: Property[],
): QuickAddSpec {
  const model = options(properties);

  return quickAddSpecFromDraft(draft, model.kinds, model.fields);
}
export function isQuickAddDraftComplete(
  draft: QuickAddDraft,
  properties: Property[],
): boolean {
  const model = options(properties);

  return complete(draft, model.kinds, model.fields);
}
export function QuickAddFields({
  draft,
  onChange,
  classProperties,
}: {
  draft: QuickAddDraft;
  onChange: (draft: QuickAddDraft) => void;
  classProperties: Property[];
}) {
  return (
    <TableQuickAddFields
      draft={draft}
      onChange={onChange}
      {...options(classProperties)}
      Input={AtomicQuickAddInput}
      Checkbox={Checkbox}
      messages={{
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
      }}
    />
  );
}

function AtomicQuickAddInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <InputWrapper>
      <InputStyled {...props} />
    </InputWrapper>
  );
}
