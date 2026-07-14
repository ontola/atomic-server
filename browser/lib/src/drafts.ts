import { core } from './ontologies/core.js';
import { drafts } from './ontologies/drafts.js';
import type { AtomicValue } from './value.js';
import type { Resource } from './resource.js';
import type { Store } from './store.js';

/**
 * Properties that identify a resource rather than describe it. A fork gets its
 * own, and a merge must never carry the fork's copies back onto the original —
 * writing the fork's `parent` onto the original would move it, and writing its
 * `genesis` would claim the original was created by the fork's signature.
 */
const IDENTITY_PROPS: ReadonlySet<string> = new Set<string>([
  core.properties.parent,
  core.properties.isA,
  core.properties.localId,
  'https://atomicdata.dev/properties/drive',
  'https://atomicdata.dev/properties/genesis',
  'https://atomicdata.dev/properties/lastCommit',
  drafts.properties.originalSubject,
]);

const contentPropsOf = (resource: Resource): Record<string, AtomicValue> =>
  Object.fromEntries(
    Object.entries(resource.getPropVals()).filter(
      ([prop]) => !IDENTITY_PROPS.has(prop),
    ),
  );

/** Whether this resource proposes a change to another one. */
export const isDraft = (resource: Resource): boolean =>
  resource.getClasses().includes(drafts.classes.draft);

/**
 * Fork a resource into a Draft: a new resource that carries the original's
 * content and classes, plus the `Draft` class and a link back to the original.
 *
 * The fork is an ordinary resource. It is private exactly when `parent` is —
 * putting it in a folder that carries no public read grant is what keeps an
 * unpublished draft unpublished.
 *
 * Use this both to stage your own edit to a resource you can write, and to
 * suggest an edit to one you cannot — in the latter case `parent` is a folder
 * on your own drive.
 */
export async function forkResource(
  store: Store,
  original: Resource,
  parent: string,
): Promise<Resource> {
  const draft = await store.newResource({
    parent,
    isA: [...original.getClasses(), drafts.classes.draft],
    propVals: {
      ...contentPropsOf(original),
      [drafts.properties.originalSubject]: original.subject,
    },
  });

  await draft.save();

  return draft;
}

/**
 * Merge a Draft onto the resource it forked, as a single commit signed by the
 * current agent — so merging needs no special authorization: it succeeds exactly
 * when the agent may write to the original.
 *
 * This is a squash. The original receives the draft's resulting *state*, not its
 * individual edits, so the draft's revision history stays behind on the fork
 * rather than becoming part of the original's (and, once published, public) doc.
 *
 * Because it is last-write-wins per property, it cannot faithfully merge a
 * rich-text `doc` container that changed on both sides. Classes with such a
 * container need an oplog merge instead.
 *
 * Returns the updated original. The draft is left alone — discard it separately
 * if you want it gone.
 */
export async function mergeDraft(
  store: Store,
  draft: Resource,
): Promise<Resource> {
  const originalSubject = draft.get(drafts.properties.originalSubject);

  if (!originalSubject) {
    throw new Error(
      `Cannot merge ${draft.subject}: it has no ${drafts.properties.originalSubject}, so it is not a draft of anything.`,
    );
  }

  const original = await store.getResource(originalSubject);
  const draftProps = contentPropsOf(draft);

  for (const [prop, value] of Object.entries(draftProps)) {
    await original.set(prop, value);
  }

  // Properties the draft dropped must be dropped from the original too,
  // otherwise deleting a value in a draft would silently not survive the merge.
  for (const prop of Object.keys(contentPropsOf(original))) {
    if (!(prop in draftProps)) {
      original.remove(prop);
    }
  }

  // A draft may add classes; it never removes the original's. `Draft` itself is
  // the fork's marker and must not follow the content home.
  const mergedClasses = draft
    .getClasses()
    .filter(subject => subject !== drafts.classes.draft);

  await original.set(core.properties.isA, mergedClasses);
  await original.save();

  return original;
}
