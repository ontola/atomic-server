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

/** The grid a dashboard lays its blocks out on. */
export const GRID_COLUMNS = 12;

/** Where one block sits. `w`/`h` are in grid cells. */
export interface BlockPlacement {
  subject: string;
  x: number;
  y: number;
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
    typeof p.x === 'number' &&
    typeof p.y === 'number' &&
    typeof p.w === 'number' &&
    typeof p.h === 'number'
  );
}

export function parseLayout(stored: JSONValue | undefined): BlockPlacement[] {
  const value = asJson(stored);

  if (!Array.isArray(value)) {
    return [];
  }

  return (value as unknown[]).filter(isPlacement).map(p => ({
    subject: p.subject,
    // Clamped rather than rejected: a placement half off the grid is still a
    // decision someone made, and the grid can honour the part that fits.
    x: Math.max(0, Math.min(GRID_COLUMNS - 1, Math.round(p.x))),
    y: Math.max(0, Math.round(p.y)),
    w: Math.max(1, Math.min(GRID_COLUMNS, Math.round(p.w))),
    h: Math.max(1, Math.round(p.h)),
  }));
}

/**
 * The placement to render each block at: the stored one when there is one, and
 * the block's default size flowing after the laid-out ones when there isn't.
 *
 * A block that was added without touching the layout must never be invisible,
 * which is why `dashboard-blocks` order is the fallback rather than a
 * requirement.
 */
export function placementsFor(
  blocks: { subject: string; kind: BlockKind }[],
  stored: BlockPlacement[],
): BlockPlacement[] {
  const bySubject = new Map(stored.map(p => [p.subject, p]));

  return blocks.map(({ subject, kind }) => {
    const placement = bySubject.get(subject);

    if (placement) {
      return placement;
    }

    // `x`/`y` of -1 means "flow here": the renderer leaves it to the grid's
    // auto-placement rather than inventing coordinates that would then be
    // saved as if someone had chosen them.
    return { subject, x: -1, y: -1, ...defaultSizeFor(kind) };
  });
}
