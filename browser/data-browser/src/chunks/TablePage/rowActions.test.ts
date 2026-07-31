import { Datatype, type Property } from '@tomic/react';
import { describe, expect, it } from 'vitest';
import {
  ROW_ACTION_GENERATORS,
  ROW_ACTION_KINDS,
  isRowActionComplete,
  parseRowActions,
  propertiesForRowAction,
  rowActionKey,
  rowActionValueInput,
  type RowActionSpec,
} from './rowActions';

const property = (subject: string, datatype: Datatype): Property =>
  ({ subject, datatype, shortname: subject, description: '' }) as Property;

const DONE_AT = property('https://x/done-at', Datatype.TIMESTAMP);
const STATUS = property('https://x/status', Datatype.RESOURCEARRAY);
const BOUGHT = property('https://x/bought', Datatype.BOOLEAN);
const QTY = property('https://x/qty', Datatype.INTEGER);
const NOTES = property('https://x/notes', Datatype.MARKDOWN);

const ALL = [DONE_AT, STATUS, BOUGHT, QTY, NOTES];

const spec = (over: Partial<RowActionSpec> = {}): RowActionSpec => ({
  id: 'a',
  label: 'Do it',
  kind: 'setNow',
  property: DONE_AT.subject,
  ...over,
});

/**
 * The vocabulary is closed on purpose, so what these tests hold is the shape of
 * that closure: which verb can point at which column, what each one writes, and
 * that configuration a person or an LLM wrote is read forgivingly.
 */
describe('what each verb can point at', () => {
  it('offers only columns it can actually write', () => {
    expect(propertiesForRowAction(ALL, 'setNow')).toEqual([DONE_AT]);
    expect(propertiesForRowAction(ALL, 'toggle')).toEqual([BOUGHT]);
    expect(propertiesForRowAction(ALL, 'increment')).toEqual([QTY]);
    // Setting a literal works on a select, a text or a number — but not on a
    // checkbox, which is what `toggle` is for.
    expect(propertiesForRowAction(ALL, 'setValue')).toContain(STATUS);
    expect(propertiesForRowAction(ALL, 'setValue')).not.toContain(BOUGHT);
  });

  it('asks for a value only where one is needed', () => {
    expect(rowActionValueInput('setNow')).toBeUndefined();
    expect(rowActionValueInput('toggle')).toBeUndefined();
    expect(rowActionValueInput('setValue')?.input).toBe('select');
    expect(rowActionValueInput('increment')?.input).toBe('number');
  });

  it('describes every kind it lists, so the picker is never blank', () => {
    for (const kind of ROW_ACTION_KINDS) {
      const generator = ROW_ACTION_GENERATORS[kind];
      expect(generator.title.length).toBeGreaterThan(0);
      expect(generator.description.length).toBeGreaterThan(0);
      expect(generator.defaultLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('what a press writes', () => {
  it('stamps millis into a timestamp column', () => {
    const before = Date.now();
    const next = ROW_ACTION_GENERATORS.setNow.next(
      undefined,
      spec(),
      DONE_AT,
    ) as number;

    expect(next).toBeGreaterThanOrEqual(before);
  });

  it('stamps an ISO day into a date column, not millis', () => {
    // Nothing coerces between the two, so millis in a date column stores a value
    // that renders as an empty cell and computes as no date at all.
    const day = property('https://x/watered', Datatype.DATE);
    const next = ROW_ACTION_GENERATORS.setNow.next(
      undefined,
      spec({ property: day.subject }),
      day,
    );

    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('wraps a select value in an array, because that is how a select is stored', () => {
    const s = spec({
      kind: 'setValue',
      property: STATUS.subject,
      value: 'tag:done',
    });

    expect(ROW_ACTION_GENERATORS.setValue.next(undefined, s, STATUS)).toEqual([
      'tag:done',
    ]);
    // The same verb on a plain text column writes the bare value.
    expect(ROW_ACTION_GENERATORS.setValue.next(undefined, s, NOTES)).toBe(
      'tag:done',
    );
  });

  it('clears a toggle rather than writing false', () => {
    const s = spec({ kind: 'toggle', property: BOUGHT.subject });

    expect(ROW_ACTION_GENERATORS.toggle.next(undefined, s)).toBe(true);
    // Undefined means "remove the value": a row that was never ticked and one
    // that was un-ticked have to read the same.
    expect(ROW_ACTION_GENERATORS.toggle.next(true, s)).toBeUndefined();
  });

  it('increments from nothing as if from zero, and counts down', () => {
    const up = spec({ kind: 'increment', property: QTY.subject, value: 1 });
    const down = spec({ kind: 'increment', property: QTY.subject, value: -1 });

    expect(ROW_ACTION_GENERATORS.increment.next(undefined, up)).toBe(1);
    expect(ROW_ACTION_GENERATORS.increment.next(4, up)).toBe(5);
    expect(ROW_ACTION_GENERATORS.increment.next(4, down)).toBe(3);
  });

  it('reads back whether a row already looks done', () => {
    expect(ROW_ACTION_GENERATORS.setNow.isActive?.(1_700_000_000)).toBe(true);
    expect(ROW_ACTION_GENERATORS.setNow.isActive?.(undefined)).toBe(false);
    expect(ROW_ACTION_GENERATORS.toggle.isActive?.(true)).toBe(true);
    expect(ROW_ACTION_GENERATORS.toggle.isActive?.(undefined)).toBe(false);
    // An increment has no "done" state — pressing it again is always meaningful.
    expect(ROW_ACTION_GENERATORS.increment.isActive).toBeUndefined();
  });
});

describe('completeness', () => {
  it('needs a column', () => {
    expect(isRowActionComplete(spec())).toBe(true);
    expect(isRowActionComplete(spec({ property: '' }))).toBe(false);
  });

  it('needs a value only for the verbs that write one', () => {
    expect(
      isRowActionComplete(spec({ kind: 'setValue', property: STATUS.subject })),
    ).toBe(false);
    expect(
      isRowActionComplete(
        spec({ kind: 'setValue', property: STATUS.subject, value: 'tag:done' }),
      ),
    ).toBe(true);
  });

  it('treats a step of zero as configured, since 0 is a real number', () => {
    expect(
      isRowActionComplete(
        spec({ kind: 'increment', property: QTY.subject, value: 0 }),
      ),
    ).toBe(true);
  });
});

describe('parseRowActions', () => {
  it('reads a stored list', () => {
    expect(parseRowActions([{ ...spec() }])).toEqual([spec()]);
  });

  it('accepts a JSON string as well as an array', () => {
    // A JSON-datatype value lands as a string whenever it was written without
    // the Property loaded — reading through this keeps such config legible.
    expect(parseRowActions(JSON.stringify([spec()]))).toEqual([spec()]);
  });

  it('drops entries that are not actions, and unknown verbs', () => {
    expect(
      parseRowActions([
        { ...spec() },
        { id: 'b', label: 'x', kind: 'launchRocket', property: 'p' },
        { id: 'c' },
        'nope',
      ]),
    ).toEqual([spec()]);
  });

  it('returns nothing for anything that is not a list', () => {
    expect(parseRowActions(undefined)).toEqual([]);
    expect(parseRowActions('not json')).toEqual([]);
    expect(parseRowActions(42)).toEqual([]);
  });
});

describe('rowActionKey', () => {
  it('namespaces the column key the way derived columns do', () => {
    // The column order stores keys for property and non-property columns alike,
    // so each family needs its own prefix.
    expect(rowActionKey('watered')).toBe('action:watered');
  });
});
