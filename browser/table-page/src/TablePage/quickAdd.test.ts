import { describe, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/react';
import {
  createQuickAddRow,
  isQuickAddComplete,
  parseQuickAdd,
} from './quickAdd.js';

/**
 * A quick-add is stored config a person or an LLM writes, so what matters is that
 * it is read forgivingly: understand what fits, drop what doesn't, never throw.
 */
describe('parseQuickAdd', () => {
  it('reads a button with a field', () => {
    expect(
      parseQuickAdd({
        label: 'Add item',
        field: 'https://x/name',
        placeholder: 'What do you need?',
      }),
    ).toEqual({
      label: 'Add item',
      field: 'https://x/name',
      placeholder: 'What do you need?',
      presets: [],
    });
  });

  it('reads a button with no field — the one-tap logger', () => {
    // "Log a feed" asks for nothing; it just records that it happened.
    expect(
      parseQuickAdd({
        label: 'Log a feed',
        presets: [{ kind: 'setNow', property: 'https://x/at' }],
      }),
    ).toEqual({
      label: 'Log a feed',
      presets: [{ kind: 'setNow', property: 'https://x/at' }],
    });
  });

  it('needs a label, because the button has to say something', () => {
    expect(parseQuickAdd({ label: '' })).toBeUndefined();
    expect(parseQuickAdd({ field: 'https://x/name' })).toBeUndefined();
  });

  it('treats an empty field as no field at all', () => {
    // Otherwise the bar renders an input that writes to nothing.
    expect(parseQuickAdd({ label: 'Add', field: '' })?.field).toBeUndefined();
  });

  it('drops presets that name no verb this codebase knows', () => {
    expect(
      parseQuickAdd({
        label: 'Add',
        presets: [
          { kind: 'setNow', property: 'https://x/at' },
          { kind: 'summonDemon', property: 'https://x/at' },
          { property: 'https://x/at' },
          'nope',
        ],
      })?.presets,
    ).toEqual([{ kind: 'setNow', property: 'https://x/at' }]);
  });

  it('accepts a JSON string as well as an object', () => {
    // A JSON-datatype value lands as a string whenever it was written without the
    // Property loaded — see the row-action and dashboard notes.
    expect(parseQuickAdd(JSON.stringify({ label: 'Add' }))?.label).toBe('Add');
  });

  it('returns nothing for anything that is not an object', () => {
    expect(parseQuickAdd(undefined)).toBeUndefined();
    expect(parseQuickAdd('not json')).toBeUndefined();
    expect(parseQuickAdd([{ label: 'Add' }])).toBeUndefined();
    expect(parseQuickAdd(42)).toBeUndefined();
  });
});

describe('isQuickAddComplete', () => {
  it('needs only a label — a button with no field is the point', () => {
    expect(isQuickAddComplete({ label: 'Log a feed' })).toBe(true);
    expect(isQuickAddComplete({ label: '' })).toBe(false);
  });
});

it('does not announce a quick-added row while its save is only queued in memory', async () => {
  const row = { save: vi.fn().mockResolvedValue('queued') };
  const notifyResourceManuallyCreated = vi.fn();
  const store = {
    getResource: vi.fn().mockResolvedValue({ get: () => undefined }),
    newResource: vi.fn().mockResolvedValue(row),
    notifyResourceManuallyCreated,
  } as unknown as Store;

  await expect(
    createQuickAddRow(store, {
      table: 'table',
      rowClass: 'class',
      spec: { label: 'Add' },
      properties: [],
    }),
  ).rejects.toThrow(/queued/);
  expect(notifyResourceManuallyCreated).not.toHaveBeenCalled();
});
