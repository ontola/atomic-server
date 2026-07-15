import { describe, it } from 'vitest';
import { core } from './index.js';
import { drafts } from './ontologies/drafts.js';
import { diffDraft, forkResource, isDraft, mergeDraft } from './drafts.js';
import { testStore } from './test-store.js';

const BLOGPOST = 'https://atomicdata.dev/classes/BlogPost';
const DRIVE = 'https://atomicdata.dev/classes/Drive';
const DOCUMENT_V2 = 'https://atomicdata.dev/classes/DocumentV2';
const PUBLIC_AGENT = 'https://atomicdata.dev/agents/publicAgent';

describe('drafts', () => {
  it('forks a resource into a draft that carries the content, the classes and a link home', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const drive = await store.newResource({
      isA: DRIVE,
      noParent: true,
    });
    await drive.save();

    const original = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: {
        [core.properties.name]: 'Cheese',
        [core.properties.description]: 'A post about cheese.',
      },
    });
    await original.save();

    const draft = await forkResource(store, original, drive.subject);

    expect(draft.subject).not.toBe(original.subject);
    expect(isDraft(draft)).toBe(true);
    expect(isDraft(original)).toBe(false);
    expect(draft.get(drafts.properties.originalSubject)).toBe(original.subject);

    // Content and classes come along...
    expect(draft.get(core.properties.name)).toBe('Cheese');
    expect(draft.getClasses()).toContain(BLOGPOST);

    // ...but the original's identity does not.
    expect(draft.get(core.properties.parent)).toBe(drive.subject);
  });

  it('merges a draft onto the original without disturbing its identity', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const drive = await store.newResource({
      isA: DRIVE,
      noParent: true,
    });
    await drive.save();

    const original = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: {
        [core.properties.name]: 'Cheese',
        [core.properties.description]: 'A post about cheese.',
      },
    });
    await original.save();

    const draftsFolder = await store.newResource({
      parent: drive.subject,
      isA: core.classes.class,
    });
    await draftsFolder.save();

    const draft = await forkResource(store, original, draftsFolder.subject);
    await draft.set(core.properties.name, 'Cheese, Revisited');
    await draft.save();

    // The original is untouched while the draft is being worked on.
    expect(original.get(core.properties.name)).toBe('Cheese');

    const merged = await mergeDraft(store, draft);

    expect(merged.subject).toBe(original.subject);
    expect(merged.get(core.properties.name)).toBe('Cheese, Revisited');
    expect(merged.get(core.properties.description)).toBe(
      'A post about cheese.',
    );

    // The merge must not move the original into the drafts folder, nor make it
    // claim to be a draft.
    expect(merged.get(core.properties.parent)).toBe(drive.subject);
    expect(merged.getClasses()).toContain(BLOGPOST);
    expect(merged.getClasses()).not.toContain(drafts.classes.draft);
    expect(merged.get(drafts.properties.originalSubject)).toBe(undefined);
  });

  it('carries a property removed in the draft through the merge', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const drive = await store.newResource({
      isA: DRIVE,
      noParent: true,
    });
    await drive.save();

    const original = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: {
        [core.properties.name]: 'Cheese',
        [core.properties.description]: 'Draft me away.',
      },
    });
    await original.save();

    const draft = await forkResource(store, original, drive.subject);
    draft.remove(core.properties.description);
    await draft.save();

    const merged = await mergeDraft(store, draft);

    expect(merged.get(core.properties.description)).toBe(undefined);
    expect(merged.get(core.properties.name)).toBe('Cheese');
  });

  it('does not carry the original’s read grant onto the draft', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const drive = await store.newResource({
      isA: DRIVE,
      noParent: true,
    });
    await drive.save();

    // A published page: explicitly readable by the public.
    const published = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: {
        [core.properties.name]: 'Cheese',
        [core.properties.read]: [PUBLIC_AGENT],
      },
    });
    await published.save();

    const draft = await forkResource(store, published, drive.subject);

    // If the draft inherited `read: [publicAgent]` it would be public the moment
    // it was created, which is the one thing a draft must never be.
    expect(draft.get(core.properties.read)).toBe(undefined);
    expect(draft.get(core.properties.write)).toBe(undefined);
    expect(draft.get(core.properties.name)).toBe('Cheese');
  });

  it('does not push the draft’s ACL onto the original when merging', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const drive = await store.newResource({
      isA: DRIVE,
      noParent: true,
    });
    await drive.save();

    const original = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: {
        [core.properties.name]: 'Cheese',
        [core.properties.read]: [PUBLIC_AGENT],
      },
    });
    await original.save();

    const draft = await forkResource(store, original, drive.subject);
    await draft.set(core.properties.name, 'Cheese Revisited');
    await draft.save();

    const merged = await mergeDraft(store, draft);

    expect(merged.get(core.properties.name)).toBe('Cheese Revisited');
    // The original keeps the grant it had; the merge neither strips nor grants.
    expect(merged.get(core.properties.read)).toEqual([PUBLIC_AGENT]);
  });

  it('forks a document body and merges concurrent body edits as a CRDT', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const drive = await store.newResource({ isA: DRIVE, noParent: true });
    await drive.save();

    // A document whose body lives in the Loro `doc` container, not in propvals.
    const original = await store.newResource({
      parent: drive.subject,
      isA: DOCUMENT_V2,
      propVals: { [core.properties.name]: 'Original Doc' },
    });
    original.getLoroDoc()!.getMap('doc').set('intro', 'shared intro');
    original.markDirty();
    await original.save();

    // Fork: the draft's body must be seeded from the original (not empty), and
    // it must record a fork version for the CRDT merge.
    const draft = await forkResource(store, original, drive.subject);
    expect(draft.getLoroDoc()!.getMap('doc').get('intro')).toBe('shared intro');
    expect(draft.get(drafts.properties.forkVersion)).toBeTruthy();

    // Concurrent body edits: the draft adds one key, the original another.
    draft.getLoroDoc()!.getMap('doc').set('fromDraft', 'DRAFT');
    draft.markDirty();
    await draft.save();

    original.getLoroDoc()!.getMap('doc').set('fromOriginal', 'ORIGINAL');
    original.markDirty();
    await original.save();

    const merged = await mergeDraft(store, draft);
    const body = merged.getLoroDoc()!.getMap('doc');

    // Both concurrent body edits survive — a true merge, not an overwrite.
    expect(body.get('fromDraft')).toBe('DRAFT');
    expect(body.get('fromOriginal')).toBe('ORIGINAL');
    expect(body.get('intro')).toBe('shared intro');

    // The original keeps its identity.
    expect(merged.get(core.properties.name)).toBe('Original Doc');
    expect(merged.getClasses()).not.toContain(drafts.classes.draft);
    expect(merged.get(drafts.properties.originalSubject)).toBe(undefined);
    expect(merged.get(drafts.properties.forkVersion)).toBe(undefined);
  });

  it('refuses to merge a resource that is not a draft of anything', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const drive = await store.newResource({
      isA: DRIVE,
      noParent: true,
    });
    await drive.save();

    const orphan = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: { [core.properties.name]: 'Not a draft' },
    });
    await orphan.save();

    await expect(mergeDraft(store, orphan)).rejects.toThrow(
      /not a draft of anything/,
    );
  });

  it('merging a draft does not revert a concurrent edit to an untouched property', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const drive = await store.newResource({ isA: DRIVE, noParent: true });
    await drive.save();

    const original = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: {
        [core.properties.name]: 'Cheese',
        [core.properties.description]: 'First version.',
      },
    });
    await original.save();

    // Alice forks and changes only the name.
    const draft = await forkResource(store, original, drive.subject);
    await draft.set(core.properties.name, 'Cheese, Revisited');
    await draft.save();

    // Bob concurrently rewrites the description on the original.
    await original.set(core.properties.description, 'Bob rewrote this.');
    await original.save();

    const merged = await mergeDraft(store, draft);

    expect(merged.get(core.properties.name)).toBe('Cheese, Revisited');
    // The property the draft never touched keeps Bob's concurrent edit.
    expect(merged.get(core.properties.description)).toBe('Bob rewrote this.');
  });

  it('reports a conflict when both sides changed the same property, and can refuse to merge', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const drive = await store.newResource({ isA: DRIVE, noParent: true });
    await drive.save();

    const original = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: { [core.properties.name]: 'Cheese' },
    });
    await original.save();

    const draft = await forkResource(store, original, drive.subject);
    await draft.set(core.properties.name, 'Alice’s name');
    await draft.save();

    await original.set(core.properties.name, 'Bob’s name');
    await original.save();

    const changes = diffDraft(draft, original);
    const nameChange = changes.find(c => c.property === core.properties.name);
    expect(nameChange?.conflict).toBe(true);

    await expect(
      mergeDraft(store, draft, { onConflict: 'throw' }),
    ).rejects.toThrow(/changed on both/);

    // Nothing was written: the original still holds Bob's value.
    expect(original.get(core.properties.name)).toBe('Bob’s name');

    // Default resolution lets the draft win.
    const merged = await mergeDraft(store, draft);
    expect(merged.get(core.properties.name)).toBe('Alice’s name');
  });

  it('a property untouched by the draft is not reported as a change', async ({
    expect,
  }) => {
    const { store } = await testStore();

    const drive = await store.newResource({ isA: DRIVE, noParent: true });
    await drive.save();

    const original = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: {
        [core.properties.name]: 'Cheese',
        [core.properties.description]: 'Untouched.',
      },
    });
    await original.save();

    const draft = await forkResource(store, original, drive.subject);
    await draft.set(core.properties.name, 'Renamed');
    await draft.save();

    const changes = diffDraft(draft, original);
    expect(changes.map(c => c.property)).toEqual([core.properties.name]);
  });
});
