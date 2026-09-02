import {
  commits,
  core,
  type JSONValue,
  type Property,
  type Resource,
  type Store,
} from '@tomic/react';
import { ROW_ACTION_GENERATORS, type RowActionKind } from './rowActions';

/**
 * One value a new row starts with.
 *
 * Deliberately the *same* patch vocabulary a row action uses, applied to a row
 * that does not exist yet: `setNow` stamps the moment you pressed the button,
 * `setValue` presets a status, `toggle` starts it ticked, `increment` starts it at
 * the step. Reusing the verbs keeps the closed set closed — there is no second
 * vocabulary to learn, to document, or to write a second dialog for.
 */
export interface QuickAddPreset {
  kind: RowActionKind;
  property: string;
  value?: string | number;
}

/**
 * A button above the grid that creates a row: "Log a feed", "Add item", "Log
 * set". The timer's "what are you working on?" bar, generalised — for a personal
 * app this is usually the widget the whole thing exists for.
 */
export interface QuickAddSpec {
  /** What the button says. */
  label: string;
  /**
   * A property to type into before creating, almost always the row's name.
   * Absent means the button creates immediately, with no field at all — which is
   * what "Log a feed" wants.
   */
  field?: string;
  /** Placeholder for that field. */
  placeholder?: string;
  /** Values every new row starts with. */
  presets?: QuickAddPreset[];
}

function isPreset(value: unknown): value is QuickAddPreset {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const preset = value as Record<string, unknown>;

  return (
    typeof preset.kind === 'string' &&
    preset.kind in ROW_ACTION_GENERATORS &&
    typeof preset.property === 'string'
  );
}

/**
 * Reads the View's stored quick-add. Anything malformed is dropped rather than
 * thrown on — a person or an LLM writes this.
 */
export function parseQuickAdd(
  value: JSONValue | undefined,
): QuickAddSpec | undefined {
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as JSONValue;
          } catch {
            return undefined;
          }
        })()
      : value;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const spec = parsed as Record<string, unknown>;

  if (typeof spec.label !== 'string' || spec.label === '') {
    return undefined;
  }

  return {
    label: spec.label,
    ...(typeof spec.field === 'string' && spec.field !== ''
      ? { field: spec.field }
      : {}),
    ...(typeof spec.placeholder === 'string'
      ? { placeholder: spec.placeholder }
      : {}),
    presets: Array.isArray(spec.presets)
      ? (spec.presets as unknown[]).filter(isPreset)
      : [],
  };
}

/** Whether pressing the button can do anything yet. */
export function isQuickAddComplete(spec: QuickAddSpec): boolean {
  return spec.label !== '';
}

/**
 * Creates one row from a quick-add, and saves it.
 *
 * `createdAt` is set explicitly: the table's collection sorts on it, and a row
 * without one never appears. (The timer's bespoke bar learned this the hard way.)
 */
export async function createQuickAddRow(
  store: Store,
  opts: {
    table: string;
    rowClass: string;
    spec: QuickAddSpec;
    /** What was typed into the field, when the spec has one. */
    typed?: string;
    /** The row class's properties, so a preset knows the datatype it writes. */
    properties: Property[];
  },
): Promise<Resource> {
  const { table, rowClass, spec, typed, properties } = opts;

  const propVals: Record<string, JSONValue> = {
    [commits.properties.createdAt]: Date.now(),
  };

  if (spec.field && typed !== undefined && typed !== '') {
    propVals[spec.field] = typed;
  }

  for (const preset of spec.presets ?? []) {
    const generator = ROW_ACTION_GENERATORS[preset.kind];

    if (!generator) {
      continue;
    }

    // A brand-new row has no current value, so every verb reads as its opening
    // move: now, the literal, ticked, one step up.
    const next = generator.next(
      undefined,
      { id: '', label: '', ...preset },
      properties.find(p => p.subject === preset.property),
    );

    if (next !== undefined) {
      propVals[preset.property] = next;
    }
  }

  const row = await store.newResource({
    parent: table,
    isA: rowClass,
    propVals,
  });
  await row.save();
  // Tells the rest of the app a row appeared that it did not ask for — the
  // sidebar, the search index, anything watching the parent.
  store.notifyResourceManuallyCreated(row);

  return row;
}

/** The property a quick-add's field should default to: the row's own name. */
export const DEFAULT_QUICK_ADD_FIELD = core.properties.name;
