import { describe, expect, it, vi } from 'vitest';
import { PREFETCH_LIMIT, planVerdict, type PlanHost } from './plugin-plan.js';
import { Datatype } from './datatypes.js';
import type { Property } from './store.js';
import type { Verdict } from './plugin-run.js';
import type { JSONValue } from './value.js';

const NAME = 'https://x/name';
const AGE = 'https://x/age';
const LINK = 'https://x/employer';

const property = (subject: string, datatype: Datatype): Property => ({
  subject,
  datatype,
  shortname: subject.split('/').pop()!,
  description: '',
});

const SCHEMA: Record<string, Property> = {
  [NAME]: property(NAME, Datatype.STRING),
  [AGE]: property(AGE, Datatype.INTEGER),
  [LINK]: property(LINK, Datatype.ATOMIC_URL),
};

interface HostOpts {
  resources?: Record<string, Record<string, JSONValue>>;
}

const makeHost = ({ resources = {} }: HostOpts = {}) => {
  let n = 0;

  const host: PlanHost = {
    createSubject: vi.fn((parent?: string) => `${parent}/new-${++n}`),
    getProperty: vi.fn(async (subject: string) => {
      const found = SCHEMA[subject];

      if (!found) throw new Error(`Property ${subject} is not found`);

      return found;
    }),
    readResource: vi.fn(async (subject: string) => resources[subject]),
  };

  return host;
};

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  intents: [],
  problems: [],
  ...over,
});

describe('minting subjects', () => {
  it('mints under the given parent and records the mapping', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          {
            op: 'create',
            localId: 'org',
            parent: 'https://x/drive',
            isA: ['https://x/Org'],
            set: { [NAME]: 'Acme' },
          },
        ],
      }),
      makeHost(),
    );

    expect(plan.blocked).toBe(false);
    expect(plan.minted.org).toBe('https://x/drive/new-1');
    expect(plan.changes[0]).toMatchObject({
      op: 'create',
      subject: 'https://x/drive/new-1',
      localId: 'org',
      isA: ['https://x/Org'],
    });
  });

  it('mints a child under the parent created in the same run', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          {
            op: 'create',
            localId: 'child',
            parent: 'local:folder',
            isA: [],
            set: {},
          },
          {
            op: 'create',
            localId: 'folder',
            parent: 'https://x/drive',
            isA: [],
            set: {},
          },
        ],
      }),
      makeHost(),
    );

    expect(plan.minted.child.startsWith(plan.minted.folder)).toBe(true);
  });

  it('rewrites local references onto the minted subject', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          {
            op: 'create',
            localId: 'org',
            parent: 'https://x/drive',
            isA: [],
            set: {},
          },
          {
            op: 'set',
            subject: 'https://x/contact',
            set: { [LINK]: 'local:org' },
          },
        ],
      }),
      makeHost({ resources: { 'https://x/contact': {} } }),
    );

    expect(plan.changes[1].properties[0].to).toBe(plan.minted.org);
  });

  it('refuses creates that parent each other instead of hanging', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          { op: 'create', localId: 'a', parent: 'local:b', isA: [], set: {} },
          { op: 'create', localId: 'b', parent: 'local:a', isA: [], set: {} },
        ],
      }),
      makeHost(),
    );

    expect(plan.blocked).toBe(true);
    expect(plan.problems[0].message).toContain('a, b');
    expect(plan.changes).toEqual([]);
  });
});

describe('schema checks', () => {
  it('blocks a value whose property does not exist', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          {
            op: 'create',
            localId: 'a',
            parent: 'https://x/drive',
            isA: ['https://x/Org'],
            set: { 'https://x/nope': 'value' },
          },
        ],
      }),
      makeHost(),
    );

    expect(plan.blocked).toBe(true);
    expect(plan.changes[0].problems[0].message).toContain('nowhere to go');
  });

  it('blocks a value of the wrong datatype', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          {
            op: 'create',
            localId: 'a',
            parent: 'https://x/drive',
            isA: ['https://x/Org'],
            set: { [AGE]: 'forty' },
          },
        ],
      }),
      makeHost(),
    );

    expect(plan.blocked).toBe(true);
    expect(plan.changes[0].problems[0]).toMatchObject({
      severity: 'error',
      property: AGE,
    });
    expect(plan.changes[0].problems[0].message).toContain('age');
  });

  it('looks each property up once however many intents use it', async () => {
    const host = makeHost({
      resources: { 'https://x/a': {}, 'https://x/b': {} },
    });

    await planVerdict(
      verdict({
        intents: [
          { op: 'set', subject: 'https://x/a', set: { [NAME]: 'one' } },
          { op: 'set', subject: 'https://x/b', set: { [NAME]: 'two' } },
        ],
      }),
      host,
    );

    expect(host.getProperty).toHaveBeenCalledTimes(1);
  });

  it('warns about a create with no class rather than blocking it', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          {
            op: 'create',
            localId: 'a',
            parent: 'https://x/drive',
            isA: [],
            set: {},
          },
        ],
      }),
      makeHost(),
    );

    expect(plan.blocked).toBe(false);
    expect(plan.changes[0].problems[0].severity).toBe('warning');
  });
});

describe('links between resources this run creates', () => {
  const EMPLOYER = 'https://x/employerOrg';
  const withClassType: Property = {
    subject: EMPLOYER,
    datatype: Datatype.ATOMIC_URL,
    shortname: 'employerOrg',
    description: '',
    classType: 'https://x/Org',
  };

  const hostWithClassType = () => {
    const host = makeHost();
    host.getProperty = vi.fn(async (subject: string) => {
      if (subject === EMPLOYER) return withClassType;

      const found = SCHEMA[subject];

      if (!found) throw new Error(`Property ${subject} is not found`);

      return found;
    });

    return host;
  };

  it('accepts a link to a resource created with the right class', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          {
            op: 'create',
            localId: 'org',
            parent: 'https://x/drive',
            isA: ['https://x/Org'],
            set: {},
          },
          {
            op: 'create',
            localId: 'person',
            parent: 'https://x/drive',
            isA: ['https://x/Person'],
            set: { [EMPLOYER]: 'local:org' },
          },
        ],
      }),
      hostWithClassType(),
    );

    expect(plan.blocked).toBe(false);
  });

  it('blocks a link to a resource created with the wrong class', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          {
            op: 'create',
            localId: 'note',
            parent: 'https://x/drive',
            isA: ['https://x/Note'],
            set: {},
          },
          {
            op: 'create',
            localId: 'person',
            parent: 'https://x/drive',
            isA: ['https://x/Person'],
            set: { [EMPLOYER]: 'local:note' },
          },
        ],
      }),
      hostWithClassType(),
    );

    expect(plan.blocked).toBe(true);
    expect(plan.changes[1].problems[0].message).toContain('https://x/Note');
    expect(plan.changes[1].problems[0].message).toContain('https://x/Org');
  });

  it('leaves links to resources that already exist alone', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          {
            op: 'create',
            localId: 'person',
            parent: 'https://x/drive',
            isA: ['https://x/Person'],
            set: { [EMPLOYER]: 'https://x/some-existing-thing' },
          },
        ],
      }),
      hostWithClassType(),
    );

    expect(plan.blocked).toBe(false);
  });
});

describe('existing resources', () => {
  it('blocks a change to a resource that is not there', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          { op: 'set', subject: 'https://x/ghost', set: { [NAME]: 'x' } },
        ],
      }),
      makeHost(),
    );

    expect(plan.blocked).toBe(true);
    expect(plan.changes[0].problems[0].message).toContain('does not exist');
  });

  it('shows the value being replaced', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          { op: 'set', subject: 'https://x/a', set: { [NAME]: 'new' } },
        ],
      }),
      makeHost({ resources: { 'https://x/a': { [NAME]: 'old' } } }),
    );

    expect(plan.changes[0].properties[0]).toMatchObject({
      property: NAME,
      shortname: 'name',
      from: 'old',
      to: 'new',
    });
  });

  it('skips a write that would change nothing', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [
          { op: 'set', subject: 'https://x/a', set: { [NAME]: 'same' } },
        ],
      }),
      makeHost({ resources: { 'https://x/a': { [NAME]: 'same' } } }),
    );

    expect(plan.changes[0].properties).toEqual([]);
    expect(plan.changes[0].problems[0].severity).toBe('warning');
    expect(plan.blocked).toBe(false);
  });

  it('plans a remove of a property that is set', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [{ op: 'remove', subject: 'https://x/a', properties: [NAME] }],
      }),
      makeHost({ resources: { 'https://x/a': { [NAME]: 'old' } } }),
    );

    expect(plan.changes[0].properties).toEqual([
      { property: NAME, from: 'old' },
    ]);
  });

  it('warns when removing a property that is not set', async () => {
    const plan = await planVerdict(
      verdict({
        intents: [{ op: 'remove', subject: 'https://x/a', properties: [NAME] }],
      }),
      makeHost({ resources: { 'https://x/a': {} } }),
    );

    expect(plan.changes[0].properties).toEqual([]);
    expect(plan.changes[0].problems[0].severity).toBe('warning');
  });

  it('plans a destroy of a resource that exists', async () => {
    const plan = await planVerdict(
      verdict({ intents: [{ op: 'destroy', subject: 'https://x/a' }] }),
      makeHost({ resources: { 'https://x/a': { [NAME]: 'x' } } }),
    );

    expect(plan.blocked).toBe(false);
    expect(plan.changes[0]).toMatchObject({ op: 'destroy', properties: [] });
  });
});

describe('problems from the run', () => {
  it('carries the verdict problems into the plan', async () => {
    const plan = await planVerdict(
      verdict({
        problems: [{ severity: 'warning', message: 'row 4 had no date' }],
      }),
      makeHost(),
    );

    expect(plan.problems).toHaveLength(1);
    expect(plan.blocked).toBe(false);
  });

  it('blocks when the run itself reported an error', async () => {
    const plan = await planVerdict(
      verdict({
        problems: [{ severity: 'error', message: 'name is required' }],
      }),
      makeHost(),
    );

    expect(plan.blocked).toBe(true);
  });
});

describe('temporary references from the real Store', () => {
  it('accepts only in-plan temporary references and preserves class constraints', async () => {
    const run = async (
      link: unknown,
      datatype = Datatype.ATOMIC_URL,
      classType?: string,
    ) => {
      const host = makeHost();
      host.createSubject = () => '_new:planned';
      host.getProperty = async subject => ({
        ...property(subject, datatype),
        classType,
      });
      host.readResource = async () => ({});

      return planVerdict(
        verdict({
          intents: [
            {
              op: 'create',
              localId: 'created',
              parent: 'https://x',
              isA: ['https://x/Person'],
              set: {},
            },
            {
              op: 'set',
              subject: 'https://x/existing',
              set: { [LINK]: link as JSONValue },
            },
          ],
        }),
        host,
      );
    };

    expect((await run('local:created')).blocked).toBe(false);
    expect((await run(['local:created'], Datatype.RESOURCEARRAY)).blocked).toBe(
      false,
    );
    expect((await run('_new:not-in-this-plan')).blocked).toBe(true);
    expect(
      (
        await run(
          ['local:created', '_new:not-in-this-plan'],
          Datatype.RESOURCEARRAY,
        )
      ).blocked,
    ).toBe(true);
    expect((await run('local:created', Datatype.INTEGER)).blocked).toBe(true);
    expect(
      (await run('local:created', Datatype.ATOMIC_URL, 'https://x/Project'))
        .blocked,
    ).toBe(true);
  });
});

describe('fetching', () => {
  it('fetches every property and subject it needs at once', async () => {
    const host = makeHost({
      resources: { 'https://x/1': { [NAME]: 'old' } },
    });

    let inFlight = 0;
    let peak = 0;

    const observe = async <T>(work: () => Promise<T>): Promise<T> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));

      try {
        return await work();
      } finally {
        inFlight--;
      }
    };

    const getProperty = host.getProperty;
    const readResource = host.readResource;
    host.getProperty = vi.fn(subject => observe(() => getProperty(subject)));
    host.readResource = vi.fn(subject => observe(() => readResource(subject)));

    const plan = await planVerdict(
      verdict({
        intents: [
          {
            op: 'create',
            localId: 'a',
            parent: 'https://x/drive',
            isA: [],
            set: { [NAME]: 'A', [AGE]: 1 },
          },
          { op: 'set', subject: 'https://x/1', set: { [NAME]: 'B' } },
        ],
      }),
      host,
    );

    expect(plan.changes).toHaveLength(2);
    // Two properties and one resource read. In series that is three waits in a
    // row in front of the approval dialog; a distinct property is still only
    // ever fetched once.
    expect(peak).toBe(3);
    expect(host.getProperty).toHaveBeenCalledTimes(2);
  });

  it('keeps a bounded number of reads in flight for a large edit', async () => {
    const subjects = Array.from({ length: 50 }, (_, i) => `https://x/${i}`);
    const host = makeHost({
      resources: Object.fromEntries(subjects.map(s => [s, { [NAME]: 'old' }])),
    });

    let inFlight = 0;
    let peak = 0;
    let released = false;
    const held: Array<() => void> = [];

    // Every read is held open until the test lets go, so an unbounded
    // prefetch would show all fifty in flight at once.
    const readResource = host.readResource;
    host.readResource = vi.fn(async subject => {
      inFlight++;
      peak = Math.max(peak, inFlight);

      if (!released) await new Promise<void>(resolve => held.push(resolve));

      inFlight--;

      return readResource(subject);
    });

    const planning = planVerdict(
      verdict({
        intents: subjects.map(subject => ({
          op: 'set' as const,
          subject,
          set: { [NAME]: 'new' },
        })),
      }),
      host,
    );

    await vi.waitFor(() => expect(held.length).toBe(PREFETCH_LIMIT));
    // Give an unbounded runner every chance to start more.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(inFlight).toBe(PREFETCH_LIMIT);

    released = true;
    held.forEach(release => release());

    const plan = await planning;

    expect(plan.changes).toHaveLength(subjects.length);
    expect(peak).toBe(PREFETCH_LIMIT);
    expect(host.readResource).toHaveBeenCalledTimes(subjects.length);
  });
});
