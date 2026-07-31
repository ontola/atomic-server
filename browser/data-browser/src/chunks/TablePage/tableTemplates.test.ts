import { describe, expect, it } from 'vitest';
import { TABLE_TEMPLATES } from './tableTemplates';
import { VIEW_KINDS } from './tableViewKinds';
import {
  DERIVED_COLUMN_GENERATORS,
  type DerivedColumnKind,
} from './derivedColumns';
import type { TableColumnType, TableViewSpec } from './createTableFromSpec';

/**
 * The templates are pure configuration, which means a typo in one of them is a
 * broken mini-app rather than a compile error: a total on a column that doesn't
 * exist, a kanban grouped by a text column, a computed column whose argument is
 * the wrong datatype. Nothing else checks that, so this does — cheaply, without
 * a store.
 */

/** Column types a total can be summed or averaged over. */
const NUMERIC: TableColumnType[] = ['number', 'decimal'];
/** Column types that place a row in time. */
const INSTANT: TableColumnType[] = ['date', 'datetime'];
/**
 * Column types the store can break totals down by. A text column can't: the
 * query index groups by tag subject, instant bucket or exact value, and free
 * text would make one group per row.
 */
const GROUPABLE: TableColumnType[] = [
  'select',
  'date',
  'datetime',
  'checkbox',
  'relation',
];

const templatesWithSpec = TABLE_TEMPLATES.filter(template => template.spec);

describe('table templates', () => {
  it('has a blank starting point and no other specless template', () => {
    const blank = TABLE_TEMPLATES.find(template => template.id === 'blank');
    expect(blank).toBeDefined();
    expect(blank?.spec).toBeUndefined();

    expect(
      TABLE_TEMPLATES.filter(template => !template.spec).map(t => t.id),
    ).toEqual(['blank']);
  });

  it('has unique ids', () => {
    const ids = TABLE_TEMPLATES.map(template => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each(templatesWithSpec.map(t => [t.id, t] as const))(
    '%s',
    (_id, template) => {
      const spec = template.spec!;
      const typeByColumn = new Map<string, TableColumnType>(
        spec.columns.map(column => [column.name, column.type]),
      );

      /** The type of a column a view refers to. `name` is the row's title. */
      const typeOf = (reference: string): TableColumnType | undefined =>
        reference.toLowerCase() === 'name'
          ? 'text'
          : typeByColumn.get(reference);

      it('names its rows and columns', () => {
        expect(template.rowName).not.toBe('');
        expect(spec.columns.length).toBeGreaterThan(0);
        expect(new Set(typeByColumn.keys()).size).toBe(spec.columns.length);

        for (const column of spec.columns) {
          // `name` is the row title, always present — a second one would shadow it.
          expect(column.name.toLowerCase()).not.toBe('name');

          if (column.type === 'select') {
            expect(column.options?.length ?? 0).toBeGreaterThan(1);
          } else {
            expect(column.options).toBeUndefined();
          }
        }
      });

      it('has exactly one default view, with unique names and known kinds', () => {
        const views = spec.views ?? [];
        expect(views.length).toBeGreaterThan(0);
        expect(new Set(views.map(view => view.name)).size).toBe(views.length);
        expect(views.filter(view => view.default)).toHaveLength(1);

        for (const view of views) {
          expect(VIEW_KINDS).toContain(view.kind);
        }
      });

      describe.each((spec.views ?? []).map(v => [v.name, v] as const))(
        'view %s',
        (_name, view: TableViewSpec) => {
          const derivedNames = (view.derivedColumns ?? []).map(
            derived => derived.name,
          );

          it('arranges its rows by a column that can carry it', () => {
            if (view.kind === 'kanban') {
              // The board's columns are the tags of a select column.
              expect(typeOf(view.groupByColumn ?? '')).toBe('select');
            }

            if (view.kind === 'calendar') {
              expect(INSTANT).toContain(typeOf(view.groupByColumn ?? ''));
            }

            if (view.kind === 'timer') {
              expect(typeOf(view.groupByColumn ?? '')).toBe('datetime');
              expect(typeOf(view.endColumn ?? '')).toBe('datetime');
            }
          });

          it('sorts and filters real columns', () => {
            if (view.sortByColumn !== undefined) {
              expect(typeOf(view.sortByColumn)).toBeDefined();
            }

            for (const filter of view.filters ?? []) {
              expect(typeOf(filter.column)).toBeDefined();

              // Value comparisons only mean something for numbers and instants.
              if (filter.operator && filter.operator !== 'eq') {
                expect([...NUMERIC, ...INSTANT]).toContain(
                  typeOf(filter.column),
                );
              }
            }
          });

          it('totals stored columns of a type the function accepts', () => {
            for (const aggregate of view.aggregates ?? []) {
              if (aggregate.function === 'count' && !aggregate.column) {
                continue;
              }

              const type = typeOf(aggregate.column ?? '');
              // Aggregates read stored properties: a computed column has no
              // value in the index, so totalling one would silently be empty.
              expect(
                derivedNames,
                `${aggregate.column} is a computed column`,
              ).not.toContain(aggregate.column);
              expect(type, `${aggregate.column} is not a column`).toBeDefined();

              if (
                aggregate.function === 'sum' ||
                aggregate.function === 'avg'
              ) {
                expect(NUMERIC).toContain(type);
              }

              if (
                aggregate.function === 'min' ||
                aggregate.function === 'max'
              ) {
                expect([...NUMERIC, ...INSTANT]).toContain(type);
              }
            }

            // One statistic per column per totals row, or they overwrite.
            const slots = (view.aggregates ?? []).map(
              aggregate => `${aggregate.row ?? 0}:${aggregate.column ?? ''}`,
            );
            expect(new Set(slots).size).toBe(slots.length);

            // Totals live in the grid's footer, which only the table kind draws.
            if ((view.aggregates ?? []).length > 0) {
              expect(view.kind).toBe('table');
            }
          });

          it('breaks totals down by a groupable column', () => {
            if (view.breakdownColumn === undefined) {
              return;
            }

            const type = typeOf(view.breakdownColumn);
            expect(GROUPABLE).toContain(type);

            // Buckets are a date thing; anything else groups by exact value.
            if (type && INSTANT.includes(type)) {
              expect(['day', 'month']).toContain(view.breakdownGranularity);
            } else {
              expect(view.breakdownGranularity).toBe('exact');
            }
          });

          it('computes its derived columns from arguments that fit', () => {
            for (const derived of view.derivedColumns ?? []) {
              const generator =
                DERIVED_COLUMN_GENERATORS[derived.kind as DerivedColumnKind];
              expect(generator, `unknown kind ${derived.kind}`).toBeDefined();

              for (const [name, argument] of Object.entries(generator.args)) {
                const value = derived.args[name];

                if (value === undefined) {
                  expect(
                    argument.optional,
                    `${derived.name} is missing ${name}`,
                  ).toBe(true);
                  continue;
                }

                if (typeof value === 'number') {
                  expect(argument.allowsLiteral).toBe(true);
                  continue;
                }

                const type = typeOf(value);
                expect(type, `${value} is not a column`).toBeDefined();
                expect(
                  argument.accepts === 'instant' ? INSTANT : NUMERIC,
                  `${derived.name}.${name} reads ${value}`,
                ).toContain(type);
              }

              // Arguments the generator doesn't declare are dropped silently.
              for (const name of Object.keys(derived.args)) {
                expect(Object.keys(generator.args)).toContain(name);
              }
            }
          });

          it('orders columns that exist', () => {
            for (const reference of view.columnOrder ?? []) {
              const known =
                typeOf(reference) !== undefined ||
                derivedNames.includes(reference) ||
                reference.toLowerCase() === 'timer';

              expect(known, `${reference} is not a column`).toBe(true);
            }

            expect(new Set(view.columnOrder ?? []).size).toBe(
              (view.columnOrder ?? []).length,
            );
          });
        },
      );
    },
  );
});
