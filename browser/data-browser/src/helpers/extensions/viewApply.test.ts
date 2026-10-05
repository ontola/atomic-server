import { describe, expect, it } from 'vitest';
import { Datatype, type Store } from '@tomic/react';
import { ViewChanges, MAX_VIEW_INTENTS } from './viewApply';

const NAME = 'https://x.dev/name';
const PARENT = 'https://x.dev/table';

/** A drive in memory, with writes that can be made to fail. */
function fixture(rows: Record<string, Record<string, unknown>> = {}) {
  const db = new Map(Object.entries(rows).map(([s, v]) => [s, { ...v }]));
  db.set(PARENT, {});
  const refused = new Set<string>();
  let failOn: string | undefined;
  let next = 0;

  const store = {
    getProperty: async (subject: string) => ({
      subject,
      datatype: Datatype.STRING,
      shortname: subject.split('/').pop(),
      description: '',
    }),
    getResource: async (subject: string) => ({
      error: db.has(subject) ? undefined : new Error('not found'),
      getPropVals: () => ({ ...db.get(subject) }),
    }),
  } as unknown as Store;

  const guard = (subject: string) => {
    if (failOn && subject === failOn) throw new Error('server said no');
  };

  const changes = new ViewChanges(store, {
    authorize: async subject => {
      if (refused.has(subject)) throw new Error(`may not write ${subject}`);
    },
    writes: {
      create: async ({ propVals }) => {
        const subject = `https://x.dev/new-${next++}`;
        guard(subject);
        db.set(subject, { ...propVals });

        return subject;
      },
      set: async (subject, propVals) => {
        guard(subject);
        db.set(subject, { ...db.get(subject), ...propVals });
      },
      remove: async (subject, properties) => {
        guard(subject);
        const row = { ...db.get(subject) };
        properties.forEach(p => delete row[p]);
        db.set(subject, row);
      },
      destroy: async subject => {
        guard(subject);
        db.delete(subject);
      },
    },
  });

  return {
    db,
    changes,
    refuse: (s: string) => refused.add(s),
    failOn: (s: string) => (failOn = s),
  };
}

describe('store.apply', () => {
  it('writes a linked change and reports the new subjects', async () => {
    const f = fixture({ 'https://x.dev/a': { [NAME]: 'A' } });

    const { subjects } = await f.changes.apply([
      {
        op: 'create',
        localId: 'q',
        parent: PARENT,
        isA: [],
        set: { [NAME]: 'Q' },
      },
      { op: 'set', subject: 'https://x.dev/a', set: { [NAME]: 'local:q' } },
    ]);

    expect(subjects).toEqual({ q: 'https://x.dev/new-0' });
    expect(f.db.get('https://x.dev/a')![NAME]).toBe('https://x.dev/new-0');
  });

  it('checks every write before making any', async () => {
    const f = fixture({
      'https://x.dev/a': { [NAME]: 'A' },
      'https://x.dev/b': { [NAME]: 'B' },
    });
    f.refuse('https://x.dev/b');

    await expect(
      f.changes.apply([
        { op: 'set', subject: 'https://x.dev/a', set: { [NAME]: 'A2' } },
        { op: 'set', subject: 'https://x.dev/b', set: { [NAME]: 'B2' } },
      ]),
    ).rejects.toThrow('may not write https://x.dev/b');
    expect(f.db.get('https://x.dev/a')![NAME]).toBe('A');
  });

  it('rolls back the writes before one that fails', async () => {
    const f = fixture({
      'https://x.dev/a': { [NAME]: 'A' },
      'https://x.dev/b': { [NAME]: 'B' },
    });
    f.failOn('https://x.dev/b');

    await expect(
      f.changes.apply([
        {
          op: 'create',
          localId: 'q',
          parent: PARENT,
          isA: [],
          set: { [NAME]: 'Q' },
        },
        { op: 'set', subject: 'https://x.dev/a', set: { [NAME]: 'A2' } },
        { op: 'set', subject: 'https://x.dev/b', set: { [NAME]: 'B2' } },
      ]),
    ).rejects.toThrow('Nothing was changed');
    expect(f.db.get('https://x.dev/a')![NAME]).toBe('A');
    expect(f.db.has('https://x.dev/new-0')).toBe(false);
  });

  it('undoes the latest change as one step, and only once', async () => {
    const f = fixture({ 'https://x.dev/a': { [NAME]: 'A' } });
    await f.changes.apply([
      {
        op: 'create',
        localId: 'q',
        parent: PARENT,
        isA: [],
        set: { [NAME]: 'Q' },
      },
      { op: 'set', subject: 'https://x.dev/a', set: { [NAME]: 'A2' } },
    ]);

    expect(await f.changes.undo()).toBe(true);
    expect(f.db.get('https://x.dev/a')![NAME]).toBe('A');
    expect(f.db.has('https://x.dev/new-0')).toBe(false);
    expect(await f.changes.undo()).toBe(false);
  });

  it('leaves alone what someone changed since', async () => {
    const f = fixture({ 'https://x.dev/a': { [NAME]: 'A' } });
    await f.changes.apply([
      { op: 'set', subject: 'https://x.dev/a', set: { [NAME]: 'A2' } },
    ]);
    f.db.get('https://x.dev/a')![NAME] = 'edited by someone';

    await expect(f.changes.undo()).rejects.toThrow('changed since');
    expect(f.db.get('https://x.dev/a')![NAME]).toBe('edited by someone');
  });

  it('refuses values that do not fit, and oversized changes', async () => {
    const f = fixture();

    await expect(
      f.changes.apply([{ op: 'sudo', subject: 'https://x.dev/a' }]),
    ).rejects.toThrow('Nothing was changed');
    await expect(
      f.changes.apply(
        Array.from({ length: MAX_VIEW_INTENTS + 1 }, () => ({
          op: 'destroy',
          subject: PARENT,
        })),
      ),
    ).rejects.toThrow(`at most ${MAX_VIEW_INTENTS}`);
  });
});
