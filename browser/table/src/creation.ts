import {
  TableMutationError,
  sameTableMutationTarget,
  type TableMutationRead,
  type TableMutationScope,
  type TableMutationTarget,
} from './mutations.js';

export interface TableRowCreation {
  scope: TableMutationScope;
  schemaRevision?: string;
  /** Stable field IDs. Defaults and explicit-unset policy belong to the host. */
  values: Readonly<Record<string, unknown>>;
}

export interface TableCreationBackend<Handle> {
  schema: { revision?: string };
  /** Mint the final identity and apply defaults, without persisting the row. */
  prepare: (command: TableRowCreation) => Promise<TableMutationRead<Handle>>;
  validate?: (draft: TableMutationRead<Handle>) => void | Promise<void>;
  persist: (draft: TableMutationRead<Handle>) => Promise<void>;
  read: (
    target: TableMutationTarget,
  ) => Promise<TableMutationRead<Handle> | undefined>;
  release?: (row: TableMutationRead<Handle>) => void;
  equals?: (left: unknown, right: unknown) => boolean;
}

/** Persist one prepared row and confirm its identity, scope and initial values.
 * No automatic retry/rollback: a failed confirmation may follow a successful write.
 * Deferred grid drafts must not call this until they are ready to persist. */
export async function executeTableRowCreation<Handle>(
  input: TableRowCreation,
  backend: TableCreationBackend<Handle>,
): Promise<TableMutationTarget> {
  const command = {
    ...input,
    scope: { ...input.scope },
    values: { ...input.values },
  };

  const checkSchema = () => {
    if (
      command.schemaRevision !== undefined &&
      command.schemaRevision !== backend.schema.revision
    )
      throw new TableMutationError(
        'schema',
        'The schema changed. Your draft is retained.',
      );
  };

  checkSchema();
  const draft = await backend.prepare(command);

  try {
    const target = {
      subject: draft.target.subject,
      scope: { ...command.scope },
    };
    if (!target.subject || !sameTableMutationTarget(target, draft.target))
      throw new TableMutationError(
        'scope',
        'The prepared row does not belong to this table.',
      );
    await backend.validate?.(draft);
    checkSchema();
    // Capture the expected values before the write can mutate the draft proxy.
    const expected = { ...draft.values };
    await backend.persist(draft);
    const confirmed = await backend.read(target);

    try {
      const equals = backend.equals ?? Object.is;
      if (
        !confirmed ||
        !sameTableMutationTarget(target, confirmed.target) ||
        Object.entries(expected).some(
          ([id, value]) => !equals(value, confirmed.values[id]),
        )
      )
        throw new TableMutationError(
          'confirmation',
          'The backend read did not confirm row creation.',
        );
    } finally {
      if (confirmed) backend.release?.(confirmed);
    }

    return target;
  } finally {
    backend.release?.(draft);
  }
}
