import { describe, it } from 'vitest';

import {
  freezeResources,
  SELF_PREFIX,
  UNIT_MEMBERS_KEY,
  type FreezableResource,
  type JsonValue,
} from './freeze.js';

const CORE_DATATYPE = 'https://atomicdata.dev/properties/datatype';
const CORE_SHORTNAME = 'https://atomicdata.dev/properties/shortname';
const CORE_DESCRIPTION = 'https://atomicdata.dev/properties/description';
const CORE_REQUIRES = 'https://atomicdata.dev/properties/requires';
const CORE_CLASSTYPE = 'https://atomicdata.dev/properties/classtype';
const CORE_CLASSES = 'https://atomicdata.dev/properties/classes';
const CORE_PROPERTIES = 'https://atomicdata.dev/properties/properties';

/** prop -> class -> ontology, the common acyclic schema shape. */
function acyclicSchema(): FreezableResource[] {
  return [
    {
      localId: 'p:title',
      content: {
        [CORE_SHORTNAME]: 'title',
        [CORE_DATATYPE]: 'string',
        [CORE_DESCRIPTION]: 'Task title',
      },
    },
    {
      localId: 'c:todo',
      content: {
        [CORE_SHORTNAME]: 'todo',
        [CORE_REQUIRES]: ['p:title'],
      },
    },
    {
      localId: 'o:todoApp',
      content: {
        [CORE_SHORTNAME]: 'todoApp',
        [CORE_CLASSES]: ['c:todo'],
        [CORE_PROPERTIES]: ['p:title'],
      },
    },
  ];
}

describe('freezeResources — acyclic', () => {
  it('assigns each resource a distinct did:ad:frozen id', ({ expect }) => {
    const { byLocalId } = freezeResources(acyclicSchema());

    for (const id of byLocalId.values()) {
      expect(id).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);
    }

    expect(new Set(byLocalId.values()).size).toBe(3);
  });

  it('rewrites references to the referent frozen id', ({ expect }) => {
    const { resources, byLocalId } = freezeResources(acyclicSchema());
    const byId = (localId: string) =>
      resources.find(r => r.frozenId === byLocalId.get(localId))!;
    const todoClass = byId('c:todo');
    const ontology = byId('o:todoApp');

    expect((todoClass.content as Record<string, unknown>)[CORE_REQUIRES]).toEqual(
      [byLocalId.get('p:title')],
    );
    expect((ontology.content as Record<string, unknown>)[CORE_CLASSES]).toEqual([
      byLocalId.get('c:todo'),
    ]);
    expect((ontology.content as Record<string, unknown>)[CORE_PROPERTIES]).toEqual(
      [byLocalId.get('p:title')],
    );
  });

  it('is independent of input order', ({ expect }) => {
    const forward = freezeResources(acyclicSchema());
    const reversed = freezeResources([...acyclicSchema()].reverse());

    for (const localId of ['p:title', 'c:todo', 'o:todoApp']) {
      expect(reversed.byLocalId.get(localId)).toBe(
        forward.byLocalId.get(localId),
      );
    }
  });

  it('is independent of property key order', ({ expect }) => {
    const reordered: FreezableResource[] = [
      {
        localId: 'p:title',
        content: {
          [CORE_DESCRIPTION]: 'Task title',
          [CORE_DATATYPE]: 'string',
          [CORE_SHORTNAME]: 'title',
        },
      },
    ];

    expect(freezeResources(reordered).byLocalId.get('p:title')).toBe(
      freezeResources([
        {
          localId: 'p:title',
          content: {
            [CORE_SHORTNAME]: 'title',
            [CORE_DATATYPE]: 'string',
            [CORE_DESCRIPTION]: 'Task title',
          },
        },
      ]).byLocalId.get('p:title'),
    );
  });

  it('dedupes identical content across separate runs', ({ expect }) => {
    const make = (localId: string): FreezableResource => ({
      localId,
      content: { [CORE_SHORTNAME]: 'title', [CORE_DATATYPE]: 'string' },
    });

    expect(freezeResources([make('a')]).byLocalId.get('a')).toBe(
      freezeResources([make('b')]).byLocalId.get('b'),
    );
  });

  it('changes the id when any content (incl. description) changes', ({
    expect,
  }) => {
    const base = freezeResources(acyclicSchema()).byLocalId.get('p:title');
    const edited = acyclicSchema();
    (edited[0].content as Record<string, unknown>)[CORE_DESCRIPTION] = 'Changed';

    expect(freezeResources(edited).byLocalId.get('p:title')).not.toBe(base);
  });

  it('leaves external (non-localId) references untouched', ({ expect }) => {
    const externalProp = 'https://atomicdata.dev/properties/parent';
    const { resources } = freezeResources([
      {
        localId: 'c:todo',
        content: { [CORE_SHORTNAME]: 'todo', [externalProp]: 'did:ad:someDrive' },
      },
    ]);

    expect(
      (resources[0].content as Record<string, unknown>)[externalProp],
    ).toBe('did:ad:someDrive');
  });
});

/** Person.friend (classtype Person) <-> Person.requires friend: a 2-cycle. */
function cyclicSchema(): FreezableResource[] {
  return [
    {
      localId: 'p:friend',
      content: {
        [CORE_SHORTNAME]: 'friend',
        [CORE_DATATYPE]: 'atomicURL',
        [CORE_CLASSTYPE]: 'c:person',
      },
    },
    {
      localId: 'c:person',
      content: {
        [CORE_SHORTNAME]: 'person',
        [CORE_REQUIRES]: ['p:friend'],
      },
    },
  ];
}

describe('freezeResources — cycles', () => {
  it('freezes a cycle as one unit whose members share its id', ({ expect }) => {
    const { resources, byLocalId } = freezeResources(cyclicSchema());

    expect(byLocalId.get('p:friend')).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);
    // Both members resolve to the same unit id; the unit is one frozen object.
    expect(byLocalId.get('p:friend')).toBe(byLocalId.get('c:person'));
    expect(resources).toHaveLength(1);
    expect([...resources[0].unit].sort()).toEqual(['c:person', 'p:friend']);
  });

  it('wraps members under the unit key with intra-cycle self tokens', ({
    expect,
  }) => {
    const { resources } = freezeResources(cyclicSchema());
    const members = (resources[0].content as Record<string, JsonValue>)[
      UNIT_MEMBERS_KEY
    ] as Array<Record<string, JsonValue>>;

    expect(members).toHaveLength(2);

    const friend = members.find(m => m[CORE_SHORTNAME] === 'friend')!;
    const person = members.find(m => m[CORE_SHORTNAME] === 'person')!;

    expect(friend[CORE_CLASSTYPE]).toMatch(
      new RegExp(`^${SELF_PREFIX}\\d+$`),
    );
    expect((person[CORE_REQUIRES] as string[])[0]).toMatch(
      new RegExp(`^${SELF_PREFIX}\\d+$`),
    );
  });

  it('is independent of input order', ({ expect }) => {
    const forward = freezeResources(cyclicSchema());
    const reversed = freezeResources([...cyclicSchema()].reverse());

    expect(reversed.byLocalId.get('p:friend')).toBe(
      forward.byLocalId.get('p:friend'),
    );
    expect(reversed.byLocalId.get('c:person')).toBe(
      forward.byLocalId.get('c:person'),
    );
  });

  it('re-hashes the whole unit when one member changes', ({ expect }) => {
    const before = freezeResources(cyclicSchema());
    const edited = cyclicSchema();
    (edited[0].content as Record<string, unknown>)[CORE_DESCRIPTION] = 'A friend';
    const after = freezeResources(edited);

    expect(after.byLocalId.get('p:friend')).not.toBe(
      before.byLocalId.get('p:friend'),
    );
  });

  it('verifies by re-hash: the unit id is blake3(JCS(content))', async ({
    expect,
  }) => {
    const { blake3 } = await import('@noble/hashes/blake3.js');
    const { bytesToHex, utf8ToBytes } = await import(
      '@noble/hashes/utils.js'
    );
    const { jcsCanonicalize } = await import('./jcs.js');
    const { resources } = freezeResources(cyclicSchema());
    const unit = resources[0];

    const recomputed = `did:ad:frozen:${bytesToHex(
      blake3(utf8ToBytes(jcsCanonicalize(unit.content))),
    )}`;

    expect(recomputed).toBe(unit.frozenId);
  });

  it('handles a self-referential resource as a unit', ({ expect }) => {
    const { resources, byLocalId } = freezeResources([
      {
        localId: 'c:node',
        content: {
          [CORE_SHORTNAME]: 'node',
          [CORE_CLASSTYPE]: 'c:node',
        },
      },
    ]);

    expect(byLocalId.get('c:node')).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);
    expect(resources[0].unit).toEqual(['c:node']);

    const members = (resources[0].content as Record<string, JsonValue>)[
      UNIT_MEMBERS_KEY
    ] as Array<Record<string, JsonValue>>;
    expect(members[0][CORE_CLASSTYPE]).toMatch(
      new RegExp(`^${SELF_PREFIX}\\d+$`),
    );
  });
});

describe('freezeResources — validation', () => {
  it('rejects duplicate localIds', ({ expect }) => {
    expect(() =>
      freezeResources([
        { localId: 'dup', content: {} },
        { localId: 'dup', content: {} },
      ]),
    ).toThrow('unique');
  });
});
