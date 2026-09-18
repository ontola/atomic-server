import { describe, expect, it } from 'vitest';
import { Datatype } from '../../browser/lib/src/index';
import type { FetchedPlatform } from '../localthought/schema';
import {
  clockifyImportQuery,
  clockifyProjection,
  clockifyFields,
  TIME_ENTRIES_PATH,
} from './localthought';

const term = (shortname: string, datatype = Datatype.STRING) => ({
  path: `clockify/property/${shortname}`,
  kind: 'property' as const,
  shortname,
  description: '',
  datatype,
  requires: [],
  recommends: [],
});
const fixture = (
  records: Array<Partial<FetchedPlatform['records'][number]>>,
): FetchedPlatform => ({
  platform: 'clockify',
  ontology: {
    description: '',
    terms: [
      {
        path: 'clockify/class/timeentry',
        kind: 'class',
        shortname: 'timeentry',
        description: '',
        datatype: Datatype.JSON,
        requires: [],
        recommends: ['clockify/property/description'],
      },
      term('description'),
      term('timeinterval', Datatype.JSON),
      term('type'),
    ],
  },
  records: records.map((record, index) => ({
    resource: 'timeentry',
    namespace: 'ws/user',
    id: `entry-${index}`,
    name: `entry-${index}`,
    values: {},
    ...record,
  })),
});

describe('clockifyProjection', () => {
  it('adds start/end timestamps and names entries after their description', () => {
    const projected = clockifyProjection(
      fixture([
        {
          values: {
            description: '  Fix plugin loading ',
            type: 'REGULAR',
            timeinterval: {
              start: '2026-09-08T11:00:00Z',
              end: '2026-09-08T16:00:00Z',
              duration: 'PT5H',
            },
          },
        },
      ]),
    );
    const entry = projected.ontology.terms.find(t => t.kind === 'class')!;
    const added = projected.ontology.terms.filter(t =>
      t.path.startsWith('urn:atomic:clockify:'),
    );
    expect(added.map(t => [t.shortname, t.datatype])).toEqual([
      [clockifyFields.start, Datatype.TIMESTAMP],
      [clockifyFields.end, Datatype.TIMESTAMP],
    ]);
    expect(entry.recommends).toEqual(
      expect.arrayContaining(added.map(t => t.path)),
    );
    expect(projected.records).toHaveLength(1);
    expect(projected.records[0].name).toBe('Fix plugin loading');
    expect(projected.records[0].values[clockifyFields.start]).toBe(
      Date.parse('2026-09-08T11:00:00Z'),
    );
    expect(projected.records[0].values[clockifyFields.end]).toBe(
      Date.parse('2026-09-08T16:00:00Z'),
    );
    // Provider fields are kept for the generic table.
    expect(projected.records[0].values.description).toBe(
      '  Fix plugin loading ',
    );
  });

  it('skips running timers and breaks, and falls back to a generic name', () => {
    const projected = clockifyProjection(
      fixture([
        {
          values: {
            type: 'REGULAR',
            timeinterval: { start: '2026-09-08T11:00:00Z', end: null },
          },
        },
        {
          values: {
            type: 'BREAK',
            timeinterval: {
              start: '2026-09-08T11:00:00Z',
              end: '2026-09-08T11:30:00Z',
            },
          },
        },
        {
          values: {
            type: 'REGULAR',
            timeinterval: {
              start: '2026-09-08T12:00:00Z',
              end: '2026-09-08T12:30:00Z',
            },
          },
        },
      ]),
    );
    expect(projected.records.map(r => r.id)).toEqual(['entry-2']);
    expect(projected.records[0].name).toBe('Time entry');
  });

  it('rejects entries without a valid start or with an inverted interval', () => {
    expect(() =>
      clockifyProjection(
        fixture([{ values: { timeinterval: { end: '2026-09-08T12:30:00Z' } } }]),
      ),
    ).toThrow(/no valid start/);
    expect(() =>
      clockifyProjection(
        fixture([
          {
            values: {
              timeinterval: {
                start: '2026-09-08T12:30:00Z',
                end: '2026-09-08T12:00:00Z',
              },
            },
          },
        ]),
      ),
    ).toThrow(/ends before it starts/);
  });

  it('leaves other platforms untouched', () => {
    const other = { ...fixture([]), platform: 'notion' };
    expect(clockifyProjection(other)).toBe(other);
  });
});

describe('clockifyImportQuery', () => {
  it('bounds the list operation to a rolling window in Clockify format', () => {
    const now = Date.parse('2026-09-18T14:05:09.123Z');
    expect(clockifyImportQuery({ lookbackDays: 7 }, now)).toEqual({
      query_overrides: [
        {
          path: TIME_ENTRIES_PATH,
          values: {
            start: '2026-09-11T14:05:09Z',
            end: '2026-09-18T14:05:09Z',
            'page-size': 50,
          },
        },
      ],
    });
  });

  it('rejects unsupported windows', () => {
    expect(() =>
      clockifyImportQuery({ lookbackDays: 90 as 7 }),
    ).toThrow(/7 or 30/);
  });
});
