import { Datatype, type Property } from '@tomic/react';
import {
  TableQuickAddFields,
  quickAddDraftFromSpec,
  quickAddSpecFromDraft,
  isQuickAddDraftComplete as complete,
  type QuickAddDraft,
} from '@tomic/table';
import { PropertyOption } from './DerivedColumnDialog.js';
import { TagOption } from './RowActionDialog.js';
import {
  ROW_ACTION_GENERATORS,
  type RowActionKind,
  propertiesForRowAction,
} from './rowActions.js';
import { DEFAULT_QUICK_ADD_FIELD, type QuickAddSpec } from './quickAdd.js';

export type { QuickAddDraft } from '@tomic/table';

function options(properties: Property[]) {
  return {
    kinds: (Object.keys(ROW_ACTION_GENERATORS) as RowActionKind[]).map(
      kind => ({
        kind,
        title: ROW_ACTION_GENERATORS[kind].title,
        description: ROW_ACTION_GENERATORS[kind].description,
        defaultLabel: ROW_ACTION_GENERATORS[kind].defaultLabel,
        valueField: ROW_ACTION_GENERATORS[kind].valueInput
          ? {
              input: ROW_ACTION_GENERATORS[kind].valueInput!,
              label: ROW_ACTION_GENERATORS[kind].valueLabel ?? 'Value',
            }
          : undefined,
        targets: propertiesForRowAction(properties, kind).map(property => ({
          key: property.subject,
          option: <PropertyOption key={property.subject} property={property} />,
          values: property.allowsOnly?.map(tag => ({
            key: tag,
            option: <TagOption key={tag} subject={tag} />,
          })),
        })),
      }),
    ),
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
  properties: Property[] = [],
): QuickAddSpec {
  const model = options(properties);

  return quickAddSpecFromDraft(draft, model.kinds);
}
export function isQuickAddDraftComplete(
  draft: QuickAddDraft,
  properties: Property[],
): boolean {
  return complete(draft, options(properties).kinds);
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
      presetValues={
        classProperties
          .find(candidate => candidate.subject === draft.presetProperty)
          ?.allowsOnly?.map(tag => ({
            key: tag,
            option: <TagOption key={tag} subject={tag} />,
          })) ?? []
      }
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
      }}
    />
  );
}
