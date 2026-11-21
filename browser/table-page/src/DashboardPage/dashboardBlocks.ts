import type { AggregateFunction, JSONValue } from '@tomic/react';

/**
 * What a Block shows. Stored as `block-kind`, the same string-enum shape a
 * View's `view-kind` uses — one class with a kind, rather than a class per kind,
 * so adding a kind is a renderer and a label rather than an ontology change.
 */
export type BlockKind = 'view' | 'stat' | 'chart' | 'create' | 'text';

export const BLOCK_KINDS: BlockKind[] = [
  'stat',
  'chart',
  'create',
  'view',
  'text',
];

export const BLOCK_KIND_LABELS: Record<BlockKind, string> = {
  stat: 'Number',
  chart: 'Chart',
  create: 'Button',
  view: 'Table',
  text: 'Text',
};

export const BLOCK_KIND_DESCRIPTIONS: Record<BlockKind, string> = {
  stat: 'One number over the rows a view matches.',
  chart: 'A number per category, day or month, drawn as bars.',
  create: 'A button that adds a row — "Log a feed", "Add expense".',
  view: 'A table, board or calendar, embedded and editable.',
  text: 'A heading or a note.',
};

/**
 * Stored JSON, whatever shape it arrived in.
 *
 * A JSON-datatype value is normally a native object or array, but it lands as a
 * *string* whenever it was written without the Property loaded in the store: the
 * datatype tag is what tells the read path to parse it, and that tag can only be
 * written when the datatype is known. Reading through this means config stays
 * legible either way, rather than a block silently going blank.
 */
function asJson(value: JSONValue | undefined): JSONValue | undefined {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value) as JSONValue;
  } catch {
    return undefined;
  }
}

/**
 * An unknown kind renders as a placeholder rather than breaking the page — a
 * dashboard written by an assistant (or by a newer version of the app) must
 * still open.
 */
export function isBlockKind(value: unknown): value is BlockKind {
  return (BLOCK_KINDS as string[]).includes(value as string);
}

/**
 * The number a stat or chart block shows. `derived` names a computed column of
 * the block's view instead of a stored property; `count` needs neither.
 */
export interface BlockAggregateSpec {
  function: AggregateFunction;
  property?: string;
  derived?: string;
}

const AGGREGATE_FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max'];

/** Stored config is dropped when it doesn't fit, never thrown on. */
export function parseBlockAggregate(
  stored: JSONValue | undefined,
): BlockAggregateSpec | undefined {
  const value = asJson(stored);

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const spec = value as Record<string, unknown>;

  if (
    typeof spec.function !== 'string' ||
    !AGGREGATE_FUNCTIONS.includes(spec.function)
  ) {
    return undefined;
  }

  // Every function but `count` needs something to measure.
  if (
    spec.function !== 'count' &&
    typeof spec.property !== 'string' &&
    typeof spec.derived !== 'string'
  ) {
    return undefined;
  }

  return {
    function: spec.function as AggregateFunction,
    ...(typeof spec.property === 'string' ? { property: spec.property } : {}),
    ...(typeof spec.derived === 'string' ? { derived: spec.derived } : {}),
  };
}

/**
 * The aggregate to write when a patch changes the *function* but names no column
 * — "average instead of sum". `configure_block` touches only the fields it is
 * given, and that reading applies inside `measure` too, so the target the block
 * already measures is kept.
 *
 * Throws when there is nothing to keep: writing `{ function: 'sum' }` on its own
 * produces a spec every reader rejects, which silently empties the block instead
 * of saying the instruction was incomplete.
 */
export function measureKeepingTarget(
  existing: BlockAggregateSpec | undefined,
  fn: AggregateFunction,
): BlockAggregateSpec {
  if (fn === 'count') {
    return { function: 'count' };
  }

  if (existing?.property) {
    return { function: fn, property: existing.property };
  }

  if (existing?.derived) {
    return { function: fn, derived: existing.derived };
  }

  throw new Error(
    `"${fn}" needs a column to measure, and this block does not have one yet.`,
  );
}

/** How a chart block draws its buckets — a Vega-Lite-shaped subset. */
export interface BlockChartSpec {
  mark: 'bar';
  /** The property whose values become buckets. */
  field?: string;
  /** How a date/timestamp field is bucketed. */
  granularity?: 'exact' | 'day' | 'month';
}

export function parseBlockChartSpec(
  stored: JSONValue | undefined,
): BlockChartSpec | undefined {
  const value = asJson(stored);

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const spec = value as Record<string, unknown>;

  // Only bars are drawn so far. A spec asking for a line or a point is config
  // we cannot honour, and silently drawing bars instead would misrepresent it.
  if (spec.mark !== undefined && spec.mark !== 'bar') {
    return undefined;
  }

  // Accepted flat (`{field, granularity}`) or Vega-Lite-shaped
  // (`{encoding: {x: {field, granularity}}}`), because an LLM writes the second
  // and a config dialog writes the first.
  const encoding = (spec.encoding ?? {}) as Record<string, unknown>;
  const x = (encoding.x ?? {}) as Record<string, unknown>;
  const field = spec.field ?? x.field;
  const granularity = spec.granularity ?? x.granularity ?? x.timeUnit;

  return {
    mark: 'bar',
    ...(typeof field === 'string' ? { field } : {}),
    ...(granularity === 'exact' ||
    granularity === 'day' ||
    granularity === 'month'
      ? { granularity }
      : {}),
  };
}

/** A block setting that names something belonging to its source table. */
export type TableBoundSetting = 'view' | 'measure' | 'chart';

/**
 * The settings that stop meaning anything when a block is pointed at a *different*
 * table, minus whichever the same change replaces.
 *
 * A view belongs to one table; a measure names one of its columns; a chart buckets
 * by one of them. Carry any of them across and the block asks the store to
 * aggregate a property the new class does not have — which does not error, it just
 * answers nothing, so the block goes quietly wrong rather than visibly broken.
 *
 * The config dialog has always cleared these; this is the same rule for the tool,
 * and it is the one place `configure_block` touches a field it was not given.
 */
export function staleOnTableChange(replaced: {
  view?: boolean;
  measure?: boolean;
  chart?: boolean;
}): TableBoundSetting[] {
  return (['view', 'measure', 'chart'] as const).filter(
    setting => !replaced[setting],
  );
}

/** The grid a dashboard lays its blocks out on. */
export const GRID_COLUMNS = 12;

/**
 * How big one block is, in grid cells.
 *
 * Size only — *where* a block sits comes from its position in `dashboard-blocks`
 * and the grid's own flow. Coordinates were stored here at first and read by
 * nothing, which meant a layout written by `create_dashboard` was silently
 * ignored. Free positioning is a real feature (drag and drop, see the plan); it
 * needs a renderer that honours coordinates *and* a way for a person to set them,
 * and it can add `x`/`y` back to this shape when it lands.
 */
export interface BlockPlacement {
  subject: string;
  w: number;
  h: number;
}

/**
 * How wide a block is when nothing says otherwise. A number is small, a table
 * wants the full width — so a dashboard nobody has laid out still looks laid
 * out.
 */
const DEFAULT_SIZE: Record<BlockKind, { w: number; h: number }> = {
  stat: { w: 3, h: 1 },
  chart: { w: 6, h: 2 },
  // The thing you press wants to be reachable, not clever: a third of a row.
  create: { w: 4, h: 1 },
  view: { w: 12, h: 3 },
  text: { w: 12, h: 1 },
};

export function defaultSizeFor(kind: BlockKind): { w: number; h: number } {
  return DEFAULT_SIZE[kind];
}

function isPlacement(value: unknown): value is BlockPlacement {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const p = value as Record<string, unknown>;

  return (
    typeof p.subject === 'string' &&
    typeof p.w === 'number' &&
    typeof p.h === 'number'
  );
}

export function parseLayout(stored: JSONValue | undefined): BlockPlacement[] {
  const value = asJson(stored);

  if (!Array.isArray(value)) {
    return [];
  }

  // Any `x`/`y` an older dashboard carries is read past, not rejected: the sizes
  // beside them are still what their author chose.
  return (value as unknown[]).filter(isPlacement).map(p => ({
    subject: p.subject,
    // Clamped rather than rejected: a width wider than the grid is still a
    // decision someone made, and the grid can honour the part that fits.
    w: Math.max(1, Math.min(GRID_COLUMNS, Math.round(p.w))),
    h: Math.max(1, Math.round(p.h)),
  }));
}
