import { describe, expect, it } from 'vitest';
import {
  clockifyImportQuery,
  clockifyProjection,
  resolveClockifyReferences,
  TIME_ENTRIES_PATH,
} from './localthought';

describe('clockifyProjection re-export', () => {
  // Projection behavior itself (start/end derivation, break/running-timer
  // skipping, project/member passthrough) is tested where it lives now:
  // devonian/platform-lenses/clockify/lens/projection.test.ts. This just
  // checks the wiring here still resolves to that implementation.
  it('leaves other platforms untouched', () => {
    const other = {
      platform: 'notion',
      ontology: { description: '', terms: [] },
      records: [],
    };
    expect(clockifyProjection(other)).toBe(other);
    expect(resolveClockifyReferences(other)).toEqual([]);
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
