import { core } from './ontologies/core.js';
import { drafts } from './ontologies/drafts.js';
import type { AtomicValue } from './value.js';
import type { JSONValue } from './value.js';
import type { Resource } from './resource.js';
import type { Store } from './store.js';

/**
 * Properties that say *who* a resource is and *who may reach it*, as opposed to
 * what it says. Neither a fork nor a merge may carry these across.
 *
 * Identity: writing the fork's `parent` onto the original would move it, and its
 * `genesis` would claim the original was created by the fork's signature.
 *
 * Authority (`read` / `write` / `append`): a fork must inherit its privacy from
 * the folder it lands in, never from the resource it forked. Copying them would
 * mean a draft of a *published* page carries that page's `read: [PUBLIC_AGENT]`
 * grant and is therefore itself public — which is exactly the thing drafts exist
 * to prevent. For the same reason a merge must not push the fork's ACL onto the
 * original: publishing is a move, not a copied grant.
 *
 * `isA` and the draft's own bookkeeping are excluded here too, and handled
 * explicitly by the merge.
 */
const NON_CONTENT_PROPS: ReadonlySet<string> = new Set<string>([
  core.properties.parent,
  core.properties.isA,
  core.properties.localId,
  core.properties.read,
  core.properties.write,
  'https://atomicdata.dev/properties/append',
  'https://atomicdata.dev/properties/drive',
  'https://atomicdata.dev/properties/genesis',
  'https://atomicdata.dev/properties/lastCommit',
  drafts.properties.originalSubject,
  drafts.properties.forkBase,
]);

const contentPropsOf = (resource: Resource): Record<string, AtomicValue> =>
  Object.fromEntries(
    Object.entries(resource.getPropVals()).filter(
      ([prop]) => !NON_CONTENT_PROPS.has(prop),
    ),
  );

/** Content classes, i.e. everything the resource `isA` except the Draft marker. */
const contentClassesOf = (resource: Resource): string[] =>
  resource.getClasses().filter(c => c !== drafts.classes.draft);

const valuesEqual = (a: AtomicValue | undefined, b: AtomicValue | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The forked-from content stored on the draft. A JSON-datatype property comes
 * back as a serialized string once it has round-tripped through a commit, but as
 * a live object before its first save — accept either.
 */
function readForkBase(draft: Resource): Record<string, AtomicValue> {
  const raw = draft.get(drafts.properties.forkBase);

  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, AtomicValue>;
    } catch {
      return {};
    }
  }

  return (raw ?? {}) as Record<string, AtomicValue>;
}

/**
 * One property the draft changed relative to the version it forked from. `base`
 * is the value at fork time, `draft` the value now, `original` the value on the
 * live original. `conflict` is true when the original moved away from `base`
 * too — both sides edited this property since the fork.
 */
export interface DraftChange {
  property: string;
  base: AtomicValue | undefined;
  draft: AtomicValue | undefined;
  original: AtomicValue | undefined;
  conflict: boolean;
}

/**
 * The properties a draft changed relative to what it forked, three-way against
 * the live original. A property the draft never touched is not listed, so it
 * cannot revert a concurrent edit to the original. Powers both the merge and a
 * review/diff view.
 */
export function diffDraft(draft: Resource, original: Resource): DraftChange[] {
  const base = readForkBase(draft);
  const theirs = contentPropsOf(draft);
  const ours = contentPropsOf(original);

  const changes: DraftChange[] = [];

  for (const prop of new Set([...Object.keys(base), ...Object.keys(theirs)])) {
    const baseVal = base[prop];
    const draftVal = theirs[prop];

    if (valuesEqual(baseVal, draftVal)) {
      continue; // the draft did not change this property
    }

    changes.push({
      property: prop,
      base: baseVal,
      draft: draftVal,
      original: ours[prop],
      conflict: !valuesEqual(baseVal, ours[prop]),
    });
  }

  return changes;
}

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
      // Freeze the forked-from content so a later merge can tell what the draft
      // actually changed, rather than overwriting the original wholesale. Stored
      // as JSON: content propvals are JSON-serializable (identity/binary props
      // are excluded by `contentPropsOf`).
      [drafts.properties.forkBase]: contentPropsOf(
        original,
      ) as unknown as JSONValue,
    },
  });

  await draft.save();

  return draft;
}

export interface MergeDraftOptions {
  /**
   * What to do when a property was edited on both the draft and the original
   * since the fork. `'draft-wins'` (default) takes the draft's value.
   * `'throw'` aborts the merge and writes nothing, so a caller can review the
   * conflicts (see {@link diffDraft}) and decide.
   */
  onConflict?: 'draft-wins' | 'throw';
}

/**
 * Merge a Draft onto the resource it forked, as a single commit signed by the
 * current agent — so merging needs no special authorization: it succeeds exactly
 * when the agent may write to the original.
 *
 * This is a squash, but a *three-way* one: it writes only the properties the
 * draft changed relative to the version it forked (its `forkBase`), so a
 * property the draft never touched is left alone and a concurrent edit to the
 * original survives. Where both sides changed the same property, `onConflict`
 * decides. The draft's revision history stays behind on the fork rather than
 * becoming part of the original's (and, once published, public) doc.
 *
 * It still cannot faithfully merge a rich-text `doc` container that changed on
 * both sides — that is last-write-wins within the container. Classes with such a
 * container need an oplog merge instead.
 *
 * Returns the updated original. The draft is left alone — discard it separately
 * if you want it gone.
 */
export async function mergeDraft(
  store: Store,
  draft: Resource,
  options: MergeDraftOptions = {},
): Promise<Resource> {
  const { onConflict = 'draft-wins' } = options;
  const originalSubject = draft.get(drafts.properties.originalSubject);

  if (!originalSubject) {
    throw new Error(
      `Cannot merge ${draft.subject}: it has no ${drafts.properties.originalSubject}, so it is not a draft of anything.`,
    );
  }

  const original = await store.getResource(originalSubject);
  const changes = diffDraft(draft, original);

  if (onConflict === 'throw') {
    const conflicts = changes.filter(c => c.conflict);

    if (conflicts.length > 0) {
      throw new Error(
        `Cannot merge ${draft.subject}: ${conflicts.length} propert${
          conflicts.length === 1 ? 'y was' : 'ies were'
        } changed on both the draft and the original since the fork (${conflicts
          .map(c => c.property)
          .join(', ')}). Resolve them first.`,
      );
    }
  }

  for (const change of changes) {
    if (change.draft === undefined) {
      original.remove(change.property); // the draft dropped this property
    } else {
      await original.set(change.property, change.draft);
    }
  }

  // Classes: add any class the draft has that the original now lacks, and never
  // remove one, so a class added to the original since the fork survives. `Draft`
  // itself is the fork's marker (stripped by `contentClassesOf`) and must not
  // follow the content home. Draft-side class *removal* is intentionally not
  // propagated — it is rare and the safe default is to keep the original's.
  const originalClasses = contentClassesOf(original);
  const addedClasses = contentClassesOf(draft).filter(
    c => !originalClasses.includes(c),
  );

  if (addedClasses.length > 0) {
    await original.set(core.properties.isA, [
      ...originalClasses,
      ...addedClasses,
    ]);
  }

  await original.save();

  return original;
}
