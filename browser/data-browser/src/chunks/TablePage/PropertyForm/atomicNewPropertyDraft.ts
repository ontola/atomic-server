import {
  type Core,
  Datatype,
  type JSONValue,
  type Resource,
  type Store,
  core,
  dataBrowser,
  server,
} from '@tomic/react';
import { stringToSlug } from '@helpers/stringToSlug';
import {
  copyablePropertyFields,
  createPropertyDraft,
} from '@helpers/propertyIdentity';
import type { PropertyFormCategory } from './categories';
import {
  createPropertyOnClass,
  attachPropertiesToClass,
  createSelectPropertyOnClass,
  type TagSeed,
} from '../Kanban/createSelectProperty';
import {
  CONSTRAINT_FIELDS,
  constraintPatchFromDraft,
} from './columnConstraints';

/** Returns the isA classes and propVals a draft of the given category starts with. */
const getCategoryGenesisPropVals = (
  category: PropertyFormCategory | undefined,
): { isA: string | string[]; propVals: Record<string, unknown> } => {
  switch (category) {
    case 'number':
      return {
        isA: core.classes.property,
        propVals: { [core.properties.datatype]: Datatype.INTEGER },
      };
    case 'date':
      return {
        isA: core.classes.property,
        propVals: { [core.properties.datatype]: Datatype.DATE },
      };
    case 'checkbox':
      return {
        isA: core.classes.property,
        propVals: { [core.properties.datatype]: Datatype.BOOLEAN },
      };
    case 'file':
      return {
        isA: core.classes.property,
        propVals: {
          [core.properties.datatype]: Datatype.ATOMIC_URL,
          [core.properties.classtype]: server.classes.file,
        },
      };
    case 'json':
      return {
        isA: core.classes.property,
        propVals: { [core.properties.datatype]: Datatype.JSON },
      };
    case 'localizedText':
      return {
        isA: core.classes.property,
        propVals: { [core.properties.datatype]: Datatype.LOCALIZEDTEXT },
      };
    case 'select':
      return {
        isA: [core.classes.property, dataBrowser.classes.selectProperty],
        propVals: {
          [core.properties.datatype]: Datatype.RESOURCEARRAY,
          [core.properties.classtype]: dataBrowser.classes.tag,
          [core.properties.allowsOnly]: [],
        },
      };
    case 'relation':
      return {
        isA: core.classes.property,
        propVals: { [core.properties.datatype]: Datatype.ATOMIC_URL },
      };
    case 'text':
    default:
      return {
        isA: core.classes.property,
        propVals: { [core.properties.datatype]: Datatype.STRING },
      };
  }
};

// Fields the dialog passes on separately. The constraint fields (options,
// linked class, limits) go to the table class's `constraints` map, not to the
// immutable Property.
const FORM_HANDLED_KEYS = [
  core.properties.name,
  core.properties.shortname,
  core.properties.description,
  core.properties.datatype,
  ...CONSTRAINT_FIELDS,
];

/** The tags the user added to a select draft, as seeds for the real property. */
const tagSeedsFromDraft = async (
  store: Store,
  draft: Resource,
): Promise<TagSeed[]> => {
  const subjects = draft.getSubjects(core.properties.allowsOnly);
  const seeds: TagSeed[] = [];

  for (const subject of subjects) {
    const tag = await store.getResource(subject);
    const text =
      (tag.get(core.properties.name) as string | undefined) ??
      (tag.get(core.properties.shortname) as string | undefined);

    if (!text) {
      continue;
    }

    seeds.push({
      name: text,
      color: tag.get(dataBrowser.properties.color) as string | undefined,
      emoji: tag.get(dataBrowser.properties.emoji) as string | undefined,
    });
  }

  return seeds;
};

export interface AtomicNewPropertyDraft {
  resource: Resource;
  owner: Resource<Core.Class>;
  category?: PropertyFormCategory;
  created?: string;
}
export async function prepareAtomicNewPropertyDraft(
  store: Store,
  tableClassResource: Resource<Core.Class>,
  selectedCategory?: string,
): Promise<AtomicNewPropertyDraft> {
  const parent = await store.getResource(tableClassResource.props.parent);
  const parentSubject = parent.hasClasses(core.classes.ontology)
    ? parent.subject
    : tableClassResource.subject;
  const { isA, propVals } = getCategoryGenesisPropVals(
    selectedCategory as PropertyFormCategory,
  );
  const resource = await createPropertyDraft(store, parentSubject, {
    isA,
    propVals: {
      [core.properties.name]: 'column',
      [core.properties.description]: '',
      ...(propVals as Record<string, JSONValue>),
    },
  });

  return {
    resource,
    owner: tableClassResource,
    category: selectedCategory as PropertyFormCategory,
  };
}

async function createAtomicNewProperty(
  store: Store,
  prepared: AtomicNewPropertyDraft,
): Promise<string> {
  const {
    resource: draft,
    owner: tableClassResource,
    category: selectedCategory,
  } = prepared;

  const name = (draft.get(core.properties.name) as string) ?? '';
  const shortname = stringToSlug(name.trim()) || 'column';
  const datatype = draft.get(core.properties.datatype) as Datatype;
  // A new column is always a new property: never reuse another column's.
  const naming = { name, shortname, reuse: false, deferAttach: true };

  if (selectedCategory === 'select') {
    const max = draft.get(dataBrowser.properties.max) as number | undefined;
    const { subject } = await createSelectPropertyOnClass(
      store,
      tableClassResource,
      { ...naming, tags: await tagSeedsFromDraft(store, draft), max },
    );

    return subject;
  }

  const { isA, propVals } = copyablePropertyFields(draft);

  for (const key of FORM_HANDLED_KEYS) {
    delete propVals[key];
  }

  return createPropertyOnClass(store, tableClassResource, {
    ...naming,
    datatype,
    constraint: constraintPatchFromDraft(draft),
    description: (draft.get(core.properties.description) as string) ?? '',
    // The range class only marked properties that carried `min` / `max`.
    classes: isA.filter(
      c =>
        c !== core.classes.property && c !== dataBrowser.classes.rangeProperty,
    ),
    propVals,
  });
}

export async function saveAtomicNewPropertyDraft(
  store: Store,
  prepared: AtomicNewPropertyDraft,
): Promise<void> {
  prepared.created ??= await createAtomicNewProperty(store, prepared);
  await attachPropertiesToClass(store, prepared.owner, [prepared.created]);
}
