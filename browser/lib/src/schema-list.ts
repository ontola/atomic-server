import type { AppSchemaBundle } from './app-schema.js';
import type { SchemaValue } from './schema-frozen.js';
import type { Resource } from './resource.js';

export type AppListEdit =
  | { type: 'insert'; index: number; value: SchemaValue }
  | { type: 'delete'; index: number }
  | { type: 'set'; index: number; value: SchemaValue }
  | { type: 'move'; from: number; to: number };
export function applyAppListEdit(
  items: SchemaValue[],
  edit: AppListEdit,
): void {
  const valid = (i: number, end = false) =>
    Number.isSafeInteger(i) && i >= 0 && i < items.length + (end ? 1 : 0);

  if (edit.type === 'move') {
    if (!valid(edit.from) || !valid(edit.to))
      throw new Error('List index out of bounds');
    items.splice(edit.to, 0, items.splice(edit.from, 1)[0]);
  } else {
    if (!valid(edit.index, edit.type === 'insert'))
      throw new Error('List index out of bounds');
    if (edit.type === 'insert') items.splice(edit.index, 0, edit.value);
    else if (edit.type === 'delete') items.splice(edit.index, 1);
    else items[edit.index] = edit.value;
  }
}
/** Whole-list replacement creates a movable container. Concurrent edits to the old
 * container are not transferred. Call deliberately, not as a move fallback. */
export async function replaceAppList(
  resource: Resource,
  bundle: AppSchemaBundle,
  field: string,
  items: SchemaValue[],
): Promise<void> {
  const id = bundle.fields[field];
  if (!id) throw new Error('Unknown field');
  await resource.editJsonList(id, { replacement: items });
}
export async function editAppList(
  resource: Resource,
  bundle: AppSchemaBundle,
  field: string,
  edit: AppListEdit,
): Promise<void> {
  const id = bundle.fields[field];
  if (!id) throw new Error('Unknown field');
  await resource.editJsonList(id, { edit });
}
