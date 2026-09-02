import { describe, it, expect } from 'vitest';
import type { Property } from '@tomic/react';
import type { TableColumn } from './useTableColumns';
import {
  orderColumns,
  orderKey,
  parseColumnOrder,
  reorderColumnKeys,
} from './columnOrder';

const property = (subject: string): TableColumn => ({
  key: subject,
  property: { subject } as Property,
});

/** A LocalizedText property split into one column per language. */
const split = (subject: string, tag: string): TableColumn => ({
  key: `${subject}#${tag}`,
  languageTag: tag,
  property: { subject } as Property,
});

const virtual = (key: string): TableColumn => ({
  key,
  virtual: { label: key, Cell: () => null as never },
});

const NAME = 'https://example.com/property/name';
const START = 'https://example.com/property/start';

describe('orderKey', () => {
  it('is the property for a stored column, so split languages move together', () => {
    expect(orderKey(property(NAME))).toBe(NAME);
    expect(orderKey(split(NAME, 'nl'))).toBe(NAME);
  });

  it('is the column key for a column the view added', () => {
    expect(orderKey(virtual('derived:duration'))).toBe('derived:duration');
  });
});

describe('parseColumnOrder', () => {
  it('reads a list of keys', () => {
    expect(parseColumnOrder([NAME, 'derived:duration'])).toEqual([
      NAME,
      'derived:duration',
    ]);
  });

  it('drops anything that is not a key, and non-lists entirely', () => {
    expect(parseColumnOrder([NAME, 3, null] as never)).toEqual([NAME]);
    expect(parseColumnOrder(undefined)).toEqual([]);
    expect(parseColumnOrder('nonsense' as never)).toEqual([]);
  });
});

describe('orderColumns', () => {
  const columns = [
    property(NAME),
    property(START),
    virtual('derived:duration'),
    virtual('timer-action'),
  ];

  it('leaves columns alone without a configured order', () => {
    expect(orderColumns(columns, [])).toEqual(columns);
  });

  it('puts the view-added columns wherever the order says', () => {
    const ordered = orderColumns(columns, [
      'derived:duration',
      'timer-action',
      NAME,
      START,
    ]);

    expect(ordered.map(c => c.key)).toEqual([
      'derived:duration',
      'timer-action',
      NAME,
      START,
    ]);
  });

  it('keeps unlisted columns after the listed ones, in their own order', () => {
    // A column added after the order was saved must appear, not vanish.
    const ordered = orderColumns(columns, ['timer-action']);

    expect(ordered.map(c => c.key)).toEqual([
      'timer-action',
      NAME,
      START,
      'derived:duration',
    ]);
  });

  it('keeps a split property together', () => {
    const withSplit = [property(START), split(NAME, 'en'), split(NAME, 'nl')];

    expect(orderColumns(withSplit, [NAME, START]).map(c => c.key)).toEqual([
      `${NAME}#en`,
      `${NAME}#nl`,
      START,
    ]);
  });
});

describe('reorderColumnKeys', () => {
  const columns = [
    property(NAME),
    property(START),
    virtual('derived:duration'),
  ];

  it('moves a view-added column to the front', () => {
    expect(reorderColumnKeys(columns, 2, 0)).toEqual([
      'derived:duration',
      NAME,
      START,
    ]);
  });

  it('moves a stored column after a view-added one', () => {
    expect(reorderColumnKeys(columns, 0, 2)).toEqual([
      START,
      'derived:duration',
      NAME,
    ]);
  });

  it('lists one key per property, even when it renders as several columns', () => {
    const withSplit = [split(NAME, 'en'), split(NAME, 'nl'), property(START)];

    expect(reorderColumnKeys(withSplit, 2, 0)).toEqual([START, NAME]);
  });

  it('is a no-op when the source and target are the same column', () => {
    expect(reorderColumnKeys(columns, 1, 1)).toEqual([
      NAME,
      START,
      'derived:duration',
    ]);
  });
});
