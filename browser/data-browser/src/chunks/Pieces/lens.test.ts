import { describe, expect, it } from 'vitest';
import {
  getAlongPath,
  lensGet,
  lensPut,
  parseLensMapping,
  type LensMapping,
} from './lens';

const NAME = 'https://atomicdata.dev/properties/name';
const START = 'https://drive.example/properties/work-start';
const BILLABLE = 'https://drive.example/properties/work-billable';
const DESCRIPTION = 'https://drive.example/properties/clockify-description';
const C_START = 'https://drive.example/properties/clockify-start';
const C_BILLABLE = 'https://drive.example/properties/clockify-billable';

const mapping: LensMapping = parseLensMapping({
  version: 1,
  fields: [
    { source: NAME, target: DESCRIPTION },
    { source: START, target: C_START, convert: 'ms-to-iso' },
    { source: BILLABLE, target: C_BILLABLE },
  ],
});

const row = {
  [NAME]: 'Write the report',
  [START]: Date.UTC(2026, 9, 5, 9, 0),
  [BILLABLE]: true,
  'https://drive.example/properties/notes': 'not mapped',
};

describe('lens', () => {
  it('gets the row in the target shape', () => {
    expect(lensGet(mapping, row)).toEqual({
      [DESCRIPTION]: 'Write the report',
      [C_START]: '2026-10-05T09:00:00.000Z',
      [C_BILLABLE]: true,
    });
  });

  it('obeys PutGet: what was put is what is got', () => {
    const view = {
      [DESCRIPTION]: 'Write the final report',
      [C_START]: '2026-10-05T10:00:00.000Z',
      [C_BILLABLE]: false,
    };

    expect(lensGet(mapping, lensPut(mapping, view, row))).toEqual(view);
  });

  it('obeys GetPut: putting an unchanged view changes nothing', () => {
    expect(lensPut(mapping, lensGet(mapping, row), row)).toEqual(row);
  });

  it('keeps unmapped properties on put', () => {
    const put = lensPut(mapping, { [DESCRIPTION]: 'Renamed' }, row);

    expect(put['https://drive.example/properties/notes']).toBe('not mapped');
    expect(put[NAME]).toBe('Renamed');
  });

  it('runs backwards', () => {
    expect(
      lensGet(mapping, { [C_START]: '2026-10-05T09:00:00.000Z' }, 'backward'),
    ).toEqual({ [START]: Date.UTC(2026, 9, 5, 9, 0) });
  });

  it('composes along a path', () => {
    const rename: LensMapping = {
      version: 1,
      fields: [{ source: DESCRIPTION, target: 'title' }],
    };

    expect(
      getAlongPath(
        [
          { mapping, direction: 'forward' },
          { mapping: rename, direction: 'forward' },
        ],
        row,
      ),
    ).toEqual({ title: 'Write the report' });
  });

  it('rejects overlapping ownership', () => {
    expect(() =>
      parseLensMapping({
        version: 1,
        fields: [
          { source: NAME, target: DESCRIPTION },
          { source: START, target: DESCRIPTION },
        ],
      }),
    ).toThrow(/Two fields write/);
    expect(() =>
      parseLensMapping({
        version: 1,
        fields: [{ source: NAME, target: DESCRIPTION, convert: 'eval' }],
      }),
    ).toThrow(/Unknown converter/);
  });
});
