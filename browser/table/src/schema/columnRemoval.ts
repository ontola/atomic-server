export interface TableColumnRemoval {
  readonly deleteDefinition: boolean;
  readonly canRemove: boolean;
  readonly canDeleteDefinition: boolean;
}
export interface TableColumnRemovalBackend {
  removeFromSchema: () => void | Promise<void>;
  deleteDefinition: () => void | Promise<void>;
}

/** Removing a column is not permission to delete its definition. Validate the
 * captured intent before either write, and confirm schema detachment before a
 * separately authorized deletion. Backends own identity and transaction guards;
 * the two operations are not an atomic cross-resource transaction. */
export async function executeTableColumnRemoval(
  intent: TableColumnRemoval,
  backend: TableColumnRemovalBackend,
): Promise<void> {
  const { deleteDefinition, canRemove, canDeleteDefinition } = intent;

  if (!canRemove) throw Error('Removing this column is unavailable.');
  if (deleteDefinition && !canDeleteDefinition)
    throw Error('Deleting this property is unavailable.');
  await backend.removeFromSchema();
  if (deleteDefinition) await backend.deleteDefinition();
}
