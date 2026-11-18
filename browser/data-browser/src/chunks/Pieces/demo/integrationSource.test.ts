// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { LENS_INTERPRETER_SOURCE } from '../lens';
import { integrationSource } from './integrationSource';

const source = integrationSource({
  provider: 'Clockify',
  account: 'Demo workspace',
  description: 'https://drive.example/properties/clockify-description',
  start: 'https://drive.example/properties/clockify-start',
  end: 'https://drive.example/properties/clockify-end',
  billable: 'https://drive.example/properties/clockify-billable',
  bindingClass: 'https://drive.example/classes/sync-binding',
  syncedTable: 'https://drive.example/properties/synced-table',
  syncState: 'https://drive.example/properties/sync-state',
  name: 'https://atomicdata.dev/properties/name',
});

describe('the demo integration frame', () => {
  it('runs the host interpreter, not a copy of its own', () => {
    expect(source).toContain(LENS_INTERPRETER_SOURCE);
    expect(source.match(/function lensGet\(/g)).toHaveLength(1);
  });

  it('reads rows through lensPath with that interpreter', () => {
    // The module, minus its one export, as a function body: a syntax error
    // or a name declared twice would throw here.
    const body = source.replace(
      'export async function view',
      'async function view',
    );
    const along = new Function(`${body}\nreturn along;`)() as (
      path: unknown[],
      row: Record<string, unknown>,
    ) => Record<string, unknown>;

    expect(
      along(
        [
          {
            direction: 'forward',
            mapping: {
              version: 2,
              fields: [
                {
                  source: 'https://drive.example/properties/entry-start',
                  target: '/timeInterval/start',
                  convert: 'ms-to-iso',
                },
              ],
            },
          },
        ],
        {
          'https://drive.example/properties/entry-start': Date.UTC(
            2026,
            9,
            5,
            9,
          ),
        },
      ),
    ).toEqual({ timeInterval: { start: '2026-10-05T09:00:00.000Z' } });
  });
});
