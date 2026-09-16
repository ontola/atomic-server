import {
  Datatype,
  JSONValue,
  Resource,
  Store,
  core,
  dataBrowser,
  perfSpan,
} from '@tomic/react';
import { sortSubjectList } from '@views/OntologyPage/sortSubjectList';
import { stringToSlug } from '@helpers/stringToSlug';
import { randomItem } from '@helpers/randomItem';
import { tagColours } from '@components/Tag/tagColours';

export interface TagSeed {
  name: string;
  color?: string;
}

export interface CreatedSelectProperty {
  subject: string;
  /** Tag option name → created tag subject. */
  tags: Record<string, string>;
}

/** Resolves the parent a new property of `tableClass` should be created under. */
async function resolvePropertyParent(
  store: Store,
  tableClass: Resource,
): Promise<{ subject: string; isOntology: boolean; resource: Resource }> {
  const classParentSubject = tableClass.get(core.properties.parent) as string;
  const classParent = await store.getResource(classParentSubject);
  const isOntology = classParent.hasClasses(core.classes.ontology);

  return {
    subject: isOntology ? classParent.subject : tableClass.subject,
    isOntology,
    resource: classParent,
  };
}

/**
 * Every property already registered on `ontology`, keyed by shortname. Used to
 * detect a shortname a new column would collide with before minting a
 * duplicate property that shares it — see `createPropertyOnClass` and
 * `createSelectPropertyOnClass`.
 */
async function loadOntologyPropertiesByShortname(
  store: Store,
  ontology: Resource,
): Promise<Map<string, Resource>> {
  const subjects = (ontology.get(core.properties.properties) ?? []) as string[];
  const resources = await Promise.all(
    subjects.map(subject => store.getResource(subject)),
  );
  const taken = new Map<string, Resource>();

  for (const resource of resources) {
    const shortname = resource.get(core.properties.shortname);

    if (typeof shortname === 'string' && shortname) {
      taken.set(shortname, resource);
    }
  }

  return taken;
}

/** The next shortname after `base` not already in `taken` — `status-2`,
 *  `status-3`, etc. */
function disambiguateShortname(
  taken: Map<string, Resource>,
  base: string,
): string {
  let n = 2;

  while (taken.has(`${base}-${n}`)) {
    n += 1;
  }

  return `${base}-${n}`;
}

/** A plain (non-select) property can be reused for a new column with the same
 *  shortname only if it stores the same kind of value. */
function isCompatiblePlainProperty(
  existing: Resource,
  datatype: Datatype,
): boolean {
  return (
    existing.hasClasses(core.classes.property) &&
    !existing.hasClasses(dataBrowser.classes.selectProperty) &&
    existing.get(core.properties.datatype) === datatype
  );
}

/** A select property can be reused for a new column with the same shortname
 *  only if it's actually a select (tag-backed enum), not some other property
 *  that happens to share the slug. */
function isCompatibleSelectProperty(existing: Resource): boolean {
  return (
    existing.hasClasses(core.classes.property) &&
    existing.hasClasses(dataBrowser.classes.selectProperty) &&
    existing.get(core.properties.datatype) === Datatype.RESOURCEARRAY
  );
}

/**
 * Registers already-saved properties into the class's ontology (if any) and
 * adds them as columns of the table's row class. Shared by every property
 * created for a table so they behave like hand-made columns.
 *
 * Takes a list rather than one subject because the ontology and the row class
 * are the same two resources for every column of a table: attaching per column
 * costs two round-trip commits each, attaching a whole table's columns at once
 * costs two in total. `createTableFromSpec` builds its columns with
 * `deferAttach` and calls this once at the end.
 */
export async function attachPropertiesToClass(
  store: Store,
  tableClass: Resource,
  propertySubjects: string[],
): Promise<void> {
  if (propertySubjects.length === 0) {
    return;
  }

  const closeAttach = perfSpan('table.attachPropertyToClass', {
    n: propertySubjects.length,
  });
  const classParentSubject = tableClass.get(core.properties.parent) as string;
  const classParent = await store.getResource(classParentSubject);

  if (classParent.hasClasses(core.classes.ontology)) {
    const ontologyProps = (classParent.get(core.properties.properties) ??
      []) as string[];
    // A reused property (see `createPropertyOnClass` / `createSelectPropertyOnClass`'s
    // shortname dedupe, or an explicit `column.propertySubject`) may already be
    // registered here — don't duplicate its entry.
    const newProps = propertySubjects.filter(
      subject => !ontologyProps.includes(subject),
    );
    const closeSort = perfSpan('table.sortSubjectList', {
      n: ontologyProps.length + newProps.length,
    });
    const sorted = await sortSubjectList(store, [
      ...ontologyProps,
      ...newProps,
    ]);
    closeSort();
    await classParent.set(core.properties.properties, sorted);
    const closeOntologySave = perfSpan('table.ontologySave');
    await classParent.save();
    closeOntologySave();
  }

  await tableClass.push(core.properties.recommends, propertySubjects, true);
  const closeClassSave = perfSpan('table.rowClassSave');
  await tableClass.save();
  closeClassSave();
  closeAttach();
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
    /**
     * Extra classes the property is an instance of — how a number becomes a
     * FormattedNumber, the same way the property form does it.
     */
    classes?: string[];
    /** Extra propVals, e.g. the constraints those classes recommend. */
    propVals?: Record<string, JSONValue>;
    /**
     * Skip registering the property on the ontology and the row class — the
     * caller is creating several columns at once and will call
     * {@link attachPropertiesToClass} for all of them together.
     */
    deferAttach?: boolean;
  },
): Promise<string> {
  const parent = await resolvePropertyParent(store, tableClass);
  let shortname = stringToSlug(opts.name);

  if (parent.isOntology) {
    const taken = await loadOntologyPropertiesByShortname(
      store,
      parent.resource,
    );
    const existing = taken.get(shortname);

    if (existing) {
      if (isCompatiblePlainProperty(existing, opts.datatype)) {
        if (!opts.deferAttach) {
          await attachPropertiesToClass(store, tableClass, [existing.subject]);
        }

        return existing.subject;
      }

      // A different, incompatible property already owns this shortname
      // (e.g. a "Status" text column elsewhere vs. this select column) —
      // mint under a disambiguated one instead of silently colliding.
      shortname = disambiguateShortname(taken, shortname);
    }
  }

  const propVals: Record<string, JSONValue> = {
    [core.properties.shortname]: shortname,
    [core.properties.name]: opts.name,
    [core.properties.description]: opts.description ?? '',
    [core.properties.datatype]: opts.datatype,
    ...opts.propVals,
  };

  if (opts.classtype) {
    propVals[core.properties.classtype] = opts.classtype;
  }

  const property = await store.newResource({
    parent: parent.subject,
    isA: [core.classes.property, ...(opts.classes ?? [])],
    propVals,
  });
  await property.save();

  if (!opts.deferAttach) {
    await attachPropertiesToClass(store, tableClass, [property.subject]);
  }

  return property.subject;
}

/**
 * Attaches an already-existing select property to a new table instead of
 * minting a duplicate that would share its shortname — but only if the
 * caller's requested options already exist among the property's tags.
 * Two unrelated columns can independently land on the same name (e.g. a
 * task board's "Status" of Todo/Doing/Done vs. a reading list's "Status" of
 * Want to read/Reading/Finished) without either author knowing about the
 * other, so a tag mismatch here isn't a template error — it means these are
 * different enums that happen to share a shortname. Returns `null` in that
 * case so the caller can mint a disambiguated property instead, rather than
 * silently adding options to (or failing on) a property shared elsewhere.
 */
async function reuseSelectProperty(
  store: Store,
  tableClass: Resource,
  existing: Resource,
  opts: { name: string; tags: TagSeed[]; deferAttach?: boolean },
): Promise<CreatedSelectProperty | null> {
  const optionSubjects = (existing.get(core.properties.allowsOnly) ??
    []) as string[];
  // Tags are created with only a shortname (see below) — no `core:name` — so
  // match the caller's option names against that, the same slug they were
  // minted with.
  const subjectByShortname: Record<string, string> = {};

  for (const subject of optionSubjects) {
    const tag = await store.getResource(subject);
    const shortname = tag.get(core.properties.shortname);

    if (typeof shortname === 'string') {
      subjectByShortname[shortname] = subject;
    }
  }

  const tagsByName: Record<string, string> = {};

  for (const seed of opts.tags) {
    const subject = subjectByShortname[stringToSlug(seed.name)];

    if (!subject) {
      return null;
    }

    tagsByName[seed.name] = subject;
  }

  if (!opts.deferAttach) {
    await attachPropertiesToClass(store, tableClass, [existing.subject]);
  }

  return { subject: existing.subject, tags: tagsByName };
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
  opts: {
    name: string;
    tags: TagSeed[];
    /** See {@link createPropertyOnClass}'s `deferAttach`. */
    deferAttach?: boolean;
  },
): Promise<CreatedSelectProperty> {
  const parent = await resolvePropertyParent(store, tableClass);
  let shortname = stringToSlug(opts.name);

  if (parent.isOntology) {
    const taken = await loadOntologyPropertiesByShortname(
      store,
      parent.resource,
    );
    const existing = taken.get(shortname);

    if (existing) {
      const reused = isCompatibleSelectProperty(existing)
        ? await reuseSelectProperty(store, tableClass, existing, opts)
        : null;

      if (reused) {
        return reused;
      }

      // Either a different, incompatible property already owns this
      // shortname, or it's a select property whose tags don't cover what
      // this column needs (a same-named but unrelated enum) — mint under a
      // disambiguated one instead of silently colliding.
      shortname = disambiguateShortname(taken, shortname);
    }
  }

  const property = await store.newResource({
    parent: parent.subject,
    isA: [core.classes.property, dataBrowser.classes.selectProperty],
    propVals: {
      [core.properties.shortname]: shortname,
      [core.properties.name]: opts.name,
      [core.properties.description]: '',
      [core.properties.datatype]: Datatype.RESOURCEARRAY,
      [core.properties.classtype]: dataBrowser.classes.tag,
      [core.properties.allowsOnly]: [],
    },
  });

  // Create the tags, parented to the property (same as SelectPropertyForm).
  const tagSubjects: string[] = [];
  const tagsByName: Record<string, string> = {};

  for (const seed of opts.tags) {
    const closeTag = perfSpan('table.tag');
    const closeSubject = perfSpan('table.tagUniqueSubject');
    const subject = property.subject.startsWith('did:')
      ? undefined
      : await store.buildUniqueSubjectFromParts(
          ['tag', seed.name],
          property.subject,
        );
    closeSubject();

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
    closeTag();
    tagSubjects.push(tag.subject);
    tagsByName[seed.name] = tag.subject;
  }

  await property.set(core.properties.allowsOnly, tagSubjects);
  await property.save();

  if (!opts.deferAttach) {
    await attachPropertiesToClass(store, tableClass, [property.subject]);
  }

  return { subject: property.subject, tags: tagsByName };
}

/** The default Todo / Doing / Done status seed for auto-created kanban columns. */
export const DEFAULT_STATUS_TAGS: TagSeed[] = [
  { name: 'Todo' },
  { name: 'Doing' },
  { name: 'Done' },
];
