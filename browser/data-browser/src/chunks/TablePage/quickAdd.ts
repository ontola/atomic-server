import {
  commits,
  core,
  type JSONValue,
  type Property,
  type Resource,
  type Store,
} from '@tomic/react';
import { ROW_ACTION_GENERATORS } from './rowActions';
import { createAtomicTableRow } from './atomicCreateRow';

/**
 * One value a new row starts with.
 *
 * Deliberately the *same* patch vocabulary a row action uses, applied to a row
 * that does not exist yet: `setNow` stamps the moment you pressed the button,
 * `setValue` presets a status, `toggle` starts it ticked, `increment` starts it at
 * the step. Reusing the verbs keeps the closed set closed — there is no second
 * vocabulary to learn, to document, or to write a second dialog for.
 */
import type { QuickAddSpec } from '@tomic/table';

export {
  parseQuickAdd,
  type QuickAddPreset,
  type QuickAddSpec,
} from '@tomic/table';

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

  return createAtomicTableRow(store, table, rowClass, propVals);
}

/** The property a quick-add's field should default to: the row's own name. */
export const DEFAULT_QUICK_ADD_FIELD = core.properties.name;
