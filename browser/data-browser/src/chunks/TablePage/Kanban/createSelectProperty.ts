import {
  Datatype,
  JSONValue,
  Resource,
  Store,
  core,
  dataBrowser,
} from '@tomic/react';
import { sortSubjectList } from '@views/OntologyPage/sortSubjectList';
import { stringToSlug } from '@helpers/stringToSlug';
import { randomItem } from '@helpers/randomItem';
import { tagColours } from '@components/Tag/tagColours';

export interface TagSeed {
  name: string;
  color?: string;
}

/** Resolves the parent a new property of `tableClass` should be created under. */
async function resolvePropertyParent(
  store: Store,
  tableClass: Resource,
): Promise<{ subject: string; isOntology: boolean }> {
  const classParentSubject = tableClass.get(core.properties.parent) as string;
  const classParent = await store.getResource(classParentSubject);
  const isOntology = classParent.hasClasses(core.classes.ontology);

  return {
    subject: isOntology ? classParent.subject : tableClass.subject,
    isOntology,
  };
}

/**
 * Registers an already-saved property into the class's ontology (if any) and
 * adds it as a column of the table's row class. Shared by every property
 * created for a table so they behave like hand-made columns.
 */
async function attachPropertyToClass(
  store: Store,
  tableClass: Resource,
  propertySubject: string,
): Promise<void> {
  const classParentSubject = tableClass.get(core.properties.parent) as string;
  const classParent = await store.getResource(classParentSubject);

  if (classParent.hasClasses(core.classes.ontology)) {
    const ontologyProps = classParent.get(core.properties.properties) ?? [];
    await classParent.set(
      core.properties.properties,
      await sortSubjectList(store, [...ontologyProps, propertySubject]),
    );
    await classParent.save();
  }

  await tableClass.push(core.properties.recommends, [propertySubject], true);
  await tableClass.save();
}

/**
 * Creates a plain (non-enum) property with the given datatype and attaches it
 * to the table's row class. Returns the new property's subject.
 */
export async function createPropertyOnClass(
  store: Store,
  tableClass: Resource,
  opts: {
    name: string;
    datatype: Datatype;
    classtype?: string;
    description?: string;
  },
): Promise<string> {
  const parent = await resolvePropertyParent(store, tableClass);

  const propVals: Record<string, JSONValue> = {
    [core.properties.shortname]: stringToSlug(opts.name),
    [core.properties.name]: opts.name,
    [core.properties.description]: opts.description ?? '',
    [core.properties.datatype]: opts.datatype,
  };

  if (opts.classtype) {
    propVals[core.properties.classtype] = opts.classtype;
  }

  const property = await store.newResource({
    parent: parent.subject,
    isA: core.classes.property,
    propVals,
  });
  await property.save();
  await attachPropertyToClass(store, tableClass, property.subject);

  return property.subject;
}

/**
 * Creates a SelectProperty (enum) with the given Tags and attaches it to a
 * table's row Class — mirroring `NewPropertyDialog`'s "select" genesis path so
 * the property is indistinguishable from one a user made by hand. Returns the
 * new property's subject.
 *
 * This deliberately does NOT touch the canonical atomic-data ontology: the
 * property is parented under the table class's own ontology (or the class
 * itself), so a "status" enum is per-drive template data, not a shared schema
 * change.
 */
export async function createSelectPropertyOnClass(
  store: Store,
  tableClass: Resource,
  opts: { name: string; tags: TagSeed[] },
): Promise<string> {
  const parent = await resolvePropertyParent(store, tableClass);

  const property = await store.newResource({
    parent: parent.subject,
    isA: [core.classes.property, dataBrowser.classes.selectProperty],
    propVals: {
      [core.properties.shortname]: stringToSlug(opts.name),
      [core.properties.name]: opts.name,
      [core.properties.description]: '',
      [core.properties.datatype]: Datatype.RESOURCEARRAY,
      [core.properties.classtype]: dataBrowser.classes.tag,
      [core.properties.allowsOnly]: [],
    },
  });

  // Create the tags, parented to the property (same as SelectPropertyForm).
  const tagSubjects: string[] = [];

  for (const seed of opts.tags) {
    const subject = property.subject.startsWith('did:')
      ? undefined
      : await store.buildUniqueSubjectFromParts(
          ['tag', seed.name],
          property.subject,
        );

    const tag = await store.newResource({
      subject,
      parent: property.subject,
      isA: dataBrowser.classes.tag,
      propVals: {
        [core.properties.shortname]: stringToSlug(seed.name),
        [dataBrowser.properties.color]: seed.color ?? randomItem(tagColours),
      },
    });
    await tag.save();
    tagSubjects.push(tag.subject);
  }

  await property.set(core.properties.allowsOnly, tagSubjects);
  await property.save();

  await attachPropertyToClass(store, tableClass, property.subject);

  return property.subject;
}

/** The default Todo / Doing / Done status seed for auto-created kanban columns. */
export const DEFAULT_STATUS_TAGS: TagSeed[] = [
  { name: 'Todo' },
  { name: 'Doing' },
  { name: 'Done' },
];
