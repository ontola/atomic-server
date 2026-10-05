// @wc-ignore-file
/**
 * Declarative lenses between row classes.
 *
 * This is a serialisable subset of the value-lens algebra in
 * ontola/atomic-plugins PR #271 (`devonian/src/lenses`): a lens is a
 * `recordLens` whose bindings are each a `fieldLens` (rename) or a
 * `customLens` drawn from a fixed list of named converters. Being data rather
 * than code is the point: it can live in a drive as a resource, be written by
 * a person or the assistant, and be searched as a graph without running
 * anything.
 *
 * Laws, as in #271: `get(put(view, row)) == view` for every mapped field, and
 * `put(get(row), row) == row`. Properties a lens does not map are left as
 * they were on `put`, so a round trip never loses what the other side cannot
 * see.
 */

type Value = unknown;
type Row = Record<string, Value>;

interface Converter {
  get: (value: Value) => Value;
  put: (value: Value) => Value;
}

/** Named converters. Every one is invertible, so every lens is two-way. */
export const CONVERTERS = {
  identity: { get: v => v, put: v => v },
  /** Epoch milliseconds (Atomic timestamps) to ISO 8601 (most REST APIs). */
  'ms-to-iso': {
    get: v => (typeof v === 'number' ? new Date(v).toISOString() : v),
    put: v => (typeof v === 'string' ? Date.parse(v) : v),
  },
} satisfies Record<string, Converter>;

export type ConverterName = keyof typeof CONVERTERS;

export interface LensField {
  /** Property on the source class. */
  source: string;
  /** Property on the target class. */
  target: string;
  convert?: ConverterName;
}

export interface LensMapping {
  version: 1;
  fields: LensField[];
}

export type LensDirection = 'forward' | 'backward';

/**
 * Reads a stored mapping, or explains why it is not one.
 *
 * Rejects overlapping ownership the way #271's `recordLens` does: two fields
 * writing one property would make `put` order-dependent, and the laws fail.
 */
export function parseLensMapping(input: unknown): LensMapping {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;

  if (!raw || typeof raw !== 'object' || (raw as LensMapping).version !== 1) {
    throw new Error('A lens mapping needs "version": 1');
  }

  const fields = (raw as LensMapping).fields;

  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('A lens mapping needs at least one field');
  }

  const sources = new Set<string>();
  const targets = new Set<string>();

  for (const field of fields) {
    if (typeof field?.source !== 'string' || typeof field?.target !== 'string')
      throw new Error('Every lens field needs a source and a target property');

    if (field.convert && !(field.convert in CONVERTERS))
      throw new Error(`Unknown converter: ${field.convert}`);

    if (sources.has(field.source))
      throw new Error(`Two fields read ${field.source}`);

    if (targets.has(field.target))
      throw new Error(`Two fields write ${field.target}`);

    sources.add(field.source);
    targets.add(field.target);
  }

  return { version: 1, fields };
}

function oriented(field: LensField, direction: LensDirection) {
  const converter = CONVERTERS[field.convert ?? 'identity'] as Converter;

  return direction === 'forward'
    ? { from: field.source, to: field.target, get: converter.get }
    : { from: field.target, to: field.source, get: converter.put };
}

/** The row as the other class sees it. Unmapped properties are dropped. */
export function lensGet(
  mapping: LensMapping,
  row: Row,
  direction: LensDirection = 'forward',
): Row {
  const out: Row = {};

  for (const field of mapping.fields) {
    const { from, to, get } = oriented(field, direction);

    if (row[from] !== undefined) out[to] = get(row[from]);
  }

  return out;
}

/**
 * A changed view written back onto the row it came from. Properties the lens
 * does not map keep their previous values.
 */
export function lensPut(
  mapping: LensMapping,
  view: Row,
  previous: Row,
  direction: LensDirection = 'forward',
): Row {
  const back = direction === 'forward' ? 'backward' : 'forward';

  return { ...previous, ...lensGet(mapping, view, back) };
}

export interface LensStep {
  lens: string;
  direction: LensDirection;
}

/** Runs `get` along a chain: a table's row in the shape at the chain's end. */
export function getAlongPath(
  steps: { mapping: LensMapping; direction: LensDirection }[],
  row: Row,
): Row {
  return steps.reduce(
    (current, step) => lensGet(step.mapping, current, step.direction),
    row,
  );
}
