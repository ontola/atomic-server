// @wc-ignore-file
import {
  importRecords,
  type ImportRecord,
} from '../../browser/lib/src/import-records.js';
import { demoPets } from './data.js';

/** No external provider: no operations, no secrets. */
export const manifest = {
  schemaVersion: 1,
  operations: [],
  secrets: [],
  // Declared so the host can check the install before starting the sandbox: a
  // Pets import with nothing stored pauses on the field to set rather than on
  // a destructuring error from inside run().
  config: {
    key: 'pets',
    properties: {
      table: { type: 'string', description: 'Table the pets are written to' },
      rowClass: { type: 'string', description: 'Class each imported pet gets' },
      properties: {
        type: 'object',
        description: 'Pet ontology properties, by shortname',
      },
    },
    required: ['table', 'rowClass', 'properties'],
  },
};

export interface Config {
  table: string;
  rowClass: string;
  properties: Record<string, string>;
}

interface Host {
  config?: Config;
  query(property: string, value: string): string[];
  read(subject: string): Record<string, unknown>;
}

const NAME = 'https://atomicdata.dev/properties/name';

export function run(ctx: Host) {
  // `ctx.config` itself can be absent, which is the same failure as an empty
  // one and has to read like it rather than as a TypeError.
  const { table, rowClass, properties: p } = ctx.config ?? ({} as Config);
  const missing = [
    ['table', table],
    ['rowClass', rowClass],
    ['properties', p],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length)
    throw new Error(
      `Configure the connection before running it: missing ${missing.join(', ')}`,
    );

  const pets = demoPets();
  const records: ImportRecord[] = pets.map(pet => {
    const identity = `pets:demo:${pet.id}`;

    return {
      sourceId: identity,
      localId: `pet-${pet.id}`,
      parent: table,
      isA: [rowClass],
      values: {
        [NAME]: pet.name,
        [p['pet-species']]: pet.species,
        [p['pet-breed']]: pet.breed,
        [p['pet-age']]: pet.age,
        [p['pet-mood']]: pet.mood,
        [p['pet-source-id']]: identity,
      },
    };
  });

  const result = importRecords(ctx, records);

  return {
    intents: result.intents,
    problems: [
      ...result.problems,
      {
        severity: 'warning' as const,
        message: `${pets.length} demo pets reconciled; ${result.summary.unchanged} unchanged. This is static sample data, not a live provider.`,
      },
    ],
  };
}
