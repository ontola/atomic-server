import {
  core,
  dataBrowser,
  getEffectiveConstraint,
  setClassConstraint,
  type Resource,
  type Store,
} from '@tomic/react';
import {
  getCategoryFromResource,
  type PropertyFormCategory,
} from './categories';
import {
  CONSTRAINT_FIELDS,
  applyDraftConstraint,
  seedDraftFromConstraint,
} from './columnConstraints';
import {
  applyDraftFields,
  createPropertyDraft,
  isContentAddressed,
  createContentAddressedFromDraft,
  carryValuesOver,
  replacePropertyReferences,
} from '@helpers/propertyIdentity';

const CONSTRAINT_OMIT = {
  fields: CONSTRAINT_FIELDS,
  classes: [dataBrowser.classes.rangeProperty],
};

export interface AtomicPropertyDraft {
  original: Resource;
  resource: Resource;
  owner: string;
  category?: PropertyFormCategory;
  usesDraft: boolean;
  /** Retained identity/snapshot after creation succeeds but attachment fails. */
  materialized?: Resource;
  snapshot?: Resource;
  referenceTargets: Set<Resource>;
}
export async function prepareAtomicPropertyDraft(
  store: Store,
  original: Resource,
  owner: string,
): Promise<AtomicPropertyDraft> {
  const category = getCategoryFromResource(original);
  const usesDraft = category !== 'select';
  const resource = usesDraft
    ? await createPropertyDraft(
        store,
        original.get(core.properties.parent) as string,
        { source: original },
      )
    : original;
  if (usesDraft)
    seedDraftFromConstraint(
      resource,
      getEffectiveConstraint(store, [owner], original.subject),
    );

  return {
    original,
    resource,
    owner,
    category,
    usesDraft,
    referenceTargets: new Set(),
  };
}

/** Capture the metadata resources the existing replacement service can touch.
 * Their local lists can already contain the new ID after a failed save, so a
 * retry must drain their pending writes even when old-ID discovery skips them. */
function captureReferences(
  store: Store,
  prepared: AtomicPropertyDraft,
  tableClass: Resource,
) {
  const lists = [core.properties.requires, core.properties.recommends];

  const listed = (resource: Resource, property: string) => {
    const value = resource.get(property);

    return Array.isArray(value) && value.includes(prepared.original.subject);
  };

  if (tableClass.hasClasses(core.classes.class))
    prepared.referenceTargets.add(tableClass);
  const parent = prepared.original.get(core.properties.parent);
  for (const resource of store.clientSideQuery(
    candidate =>
      (candidate.hasClasses(core.classes.class) &&
        lists.some(property => listed(candidate, property))) ||
      listed(candidate, dataBrowser.properties.viewColumns) ||
      (candidate.subject === parent &&
        candidate.hasClasses(core.classes.ontology) &&
        listed(candidate, core.properties.properties)),
  ))
    prepared.referenceTargets.add(resource);
}

async function flushReferences(prepared: AtomicPropertyDraft) {
  for (const resource of prepared.referenceTargets) await resource.save();
}

/** Atomic metadata policy, separate from UI lifecycle. Definition/reference/
 * constraint writes are separate operations; this is not cross-resource CAS. */
export async function saveAtomicPropertyDraft(
  store: Store,
  prepared: AtomicPropertyDraft,
): Promise<void> {
  const { original, resource: draft, owner, usesDraft } = prepared;

  if (!usesDraft) {
    await original.save();

    return;
  }

  const tableClass = await store.getResource(owner);
  const hasClass = tableClass.hasClasses(core.classes.class);
  const datatypeChanged =
    draft.get(core.properties.datatype) !==
    original.get(core.properties.datatype);
  const contentAddressed = isContentAddressed(original.subject);

  if (prepared.materialized || (datatypeChanged && contentAddressed)) {
    if (prepared.materialized && !prepared.snapshot)
      throw Error('Column draft checkpoint is incomplete.');
    const retry = !!prepared.materialized;
    captureReferences(store, prepared, tableClass);

    if (!prepared.materialized) {
      // Freeze the metadata intent before publishing a new definition. Failed
      // attachment retries use this same identity and constraint snapshot.
      prepared.snapshot = await createPropertyDraft(
        store,
        original.get(core.properties.parent) as string,
        { source: draft },
      );
      prepared.materialized = await createContentAddressedFromDraft(
        store,
        original.get(core.properties.parent) as string,
        prepared.snapshot,
        CONSTRAINT_OMIT,
      );
    }

    if (retry) await flushReferences(prepared);
    const created = prepared.materialized;

    if (created.subject !== original.subject) {
      await carryValuesOver(store, original, created);
      await replacePropertyReferences(
        store,
        original.subject,
        created.subject,
        hasClass ? [tableClass] : [],
      );
    }

    await flushReferences(prepared);

    if (hasClass) {
      await setClassConstraint(tableClass, original.subject, undefined);
      await applyDraftConstraint(
        tableClass,
        created.subject,
        prepared.snapshot!,
      );
      await tableClass.save();
    }

    return;
  }

  await applyDraftFields(
    original,
    draft,
    contentAddressed ? CONSTRAINT_OMIT : undefined,
  );
  await original.save();

  if (hasClass) {
    await applyDraftConstraint(tableClass, original.subject, draft);
    await tableClass.save();
  }
}
