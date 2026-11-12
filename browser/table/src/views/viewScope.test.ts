import { expect, it } from 'vitest';
import {
  assertTableViewOrder,
  assertTableViewOwner,
  assertTableViewTarget,
  selectTableView,
  tableViewReferences,
} from './viewScope.js';

it('does not turn a missing explicit view into an unfiltered default', () => {
  expect(
    selectTableView({
      views: ['owned'],
      defaultView: 'owned',
      requested: 'foreign',
    }),
  ).toEqual({ status: 'missing', subject: 'foreign' });
  expect(() => assertTableViewTarget('foreign', ['owned'])).toThrow(/not part/);
});

it('waits for metadata and preserves both hosts implicit-default policies', () => {
  expect(
    selectTableView({ views: [], requested: 'owned', loading: true }),
  ).toEqual({ status: 'loading' });
  expect(selectTableView({ views: ['owned'] })).toEqual({
    status: 'selected',
    subject: 'owned',
  });
  expect(selectTableView({ views: ['owned'], implicitDefault: true })).toEqual({
    status: 'implicit',
  });
  expect(selectTableView({ views: [] })).toEqual({ status: 'implicit' });
});

it('retains a legacy default-only reference and deduplicates tabs without mutating input', () => {
  const views = ['other', 'other'];
  expect(tableViewReferences(views, 'legacy-default')).toEqual([
    'legacy-default',
    'other',
  ]);
  expect(selectTableView({ views, defaultView: 'legacy-default' })).toEqual({
    status: 'selected',
    subject: 'legacy-default',
  });
  expect(views).toEqual(['other', 'other']);
});

it('allows an embedded override but requires its actual table/graph owner to match', () => {
  expect(selectTableView({ views: [], override: 'embedded' })).toEqual({
    status: 'selected',
    subject: 'embedded',
  });
  expect(() =>
    assertTableViewOwner(
      { table: 'alpha', graph: 'g1' },
      { table: 'beta', graph: 'g1' },
    ),
  ).toThrow(/another table/);
  expect(() =>
    assertTableViewOwner(
      { table: 'alpha', graph: 'g1' },
      { table: 'alpha', graph: 'g2' },
    ),
  ).toThrow(/another table/);
  expect(() =>
    assertTableViewOwner({ table: 'alpha' }, { table: 'alpha' }),
  ).not.toThrow();
});

it.each([['a'], ['a', 'a'], ['a', 'foreign'], ['a', 'b', 'foreign']])(
  'rejects a view reorder that changes membership: %s',
  next => {
    expect(() => assertTableViewOrder(['a', 'b'], next)).toThrow(
      /exactly once/,
    );
  },
);

it('accepts a complete order and a reference in the current table', () => {
  expect(() => assertTableViewOwner({ table: '' }, { table: '' })).toThrow();
  expect(() => assertTableViewOrder(['a', 'b'], ['b', 'a'])).not.toThrow();
  expect(() => assertTableViewTarget('a', ['a', 'b'])).not.toThrow();
});
