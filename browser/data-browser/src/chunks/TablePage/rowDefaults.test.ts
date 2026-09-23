import { describe, expect, it } from 'vitest';
import { dataBrowser, type Resource } from '@tomic/react';
import { readRowDefaults, withRowDefaults } from './rowDefaults';

const STATUS = 'https://example.com/status';
const TODO = 'https://example.com/status/todo';
const DOING = 'https://example.com/status/doing';

function tableWith(value: unknown): Resource {
  return {
    get: (property: string) =>
      property === dataBrowser.properties.tableRowDefaults ? value : undefined,
  } as unknown as Resource;
}

describe('row defaults', () => {
  it('reads nothing from a table without defaults', () => {
    expect(readRowDefaults(undefined)).toEqual({});
    expect(readRowDefaults(tableWith(undefined))).toEqual({});
    expect(readRowDefaults(tableWith(['not', 'an', 'object']))).toEqual({});
  });

  it('fills in what the caller leaves out', () => {
    const table = tableWith({ [STATUS]: [TODO] });

    expect(withRowDefaults(table, { name: 'Buy milk' })).toEqual({
      name: 'Buy milk',
      [STATUS]: [TODO],
    });
  });

  it('lets an explicit value win', () => {
    const table = tableWith({ [STATUS]: [TODO] });

    expect(withRowDefaults(table, { [STATUS]: [DOING] })).toEqual({
      [STATUS]: [DOING],
    });
  });

  it('does not share the stored array with the new row', () => {
    const stored = { [STATUS]: [TODO] };
    const row = withRowDefaults(tableWith(stored), {});

    (row[STATUS] as string[]).push(DOING);
    expect(stored[STATUS]).toEqual([TODO]);
  });
});
