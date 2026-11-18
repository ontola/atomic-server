export interface TableMutationScope {
  collection: string;
  rowClass: string;
  graph?: string;
}

export interface TableMutationTarget {
  subject: string;
  scope: TableMutationScope;
}

/** Stable field identities, not display labels or backend property aliases. */
export interface TableWriteSchema {
  revision?: string;
  columns: readonly { id: string; label?: string; writable: boolean }[];
}

export interface TableMutationRead<Handle> {
  target: TableMutationTarget;
  values: Readonly<Record<string, unknown>>;
  handle: Handle;
}

export type TableRowMutation = {
  target: TableMutationTarget;
  schemaRevision?: string;
  baseline?: Readonly<Record<string, unknown>>;
} & (
  | { kind: 'delete' }
  | {
      kind: 'update';
      changes:
        | Readonly<Record<string, unknown>>
        | ((
            current: Readonly<Record<string, unknown>>,
          ) => Readonly<Record<string, unknown>>);
    }
);

export interface TableMutationBackend<Handle> {
  schema: TableWriteSchema;
  /** Native adapters must open an independent bounded read on each call. */
  read: (
    target: TableMutationTarget,
  ) => Promise<TableMutationRead<Handle> | undefined>;
  /** Optional preflight; the backend always owns its validation/write policy. */
  validate?: (
    current: TableMutationRead<Handle>,
    candidate: Readonly<Record<string, unknown>>,
  ) => void | Promise<void>;
  write: (
    current: TableMutationRead<Handle>,
    command: TableRowMutation,
    changes: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  release?: (current: TableMutationRead<Handle>) => void;
  /** Compare values using the declared type of this stable property identity. */
  equals?: (left: unknown, right: unknown, propertyId: string) => boolean;
}

export class TableMutationError extends Error {
  constructor(
    public readonly code:
      | 'missing-row'
      | 'scope'
      | 'schema'
      | 'field'
      | 'conflict'
      | 'confirmation',
    message: string,
  ) {
    super(message);
    this.name = 'TableMutationError';
  }
}

/** Build one immutable row update, preserving non-selected localized values. */
export function clearTableFields(
  values: Readonly<Record<string, unknown>>,
  fields: readonly { id: string; language?: string }[],
): Record<string, unknown> {
  const changes: Record<string, unknown> = Object.create(null);

  for (const field of fields) {
    if (field.language === undefined) {
      changes[field.id] = undefined;
      continue;
    }

    const existing = Object.hasOwn(changes, field.id)
      ? changes[field.id]
      : values[field.id];
    const map =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? ({ ...existing } as Record<string, unknown>)
        : {};
    delete map[field.language];
    changes[field.id] = Object.keys(map).length ? map : undefined;
  }

  return changes;
}

export function sameTableMutationTarget(
  expected: TableMutationTarget,
  actual: TableMutationTarget,
) {
  return (
    expected.subject === actual.subject &&
    expected.scope.collection === actual.scope.collection &&
    expected.scope.rowClass === actual.scope.rowClass &&
    (expected.scope.graph === undefined ||
      expected.scope.graph === actual.scope.graph)
  );
}

/** One row command. A thrown error leaves the caller's draft/command intact.
 * Preflight + read-back are not a cross-peer atomic compare-and-swap. */
export async function executeTableRowMutation<Handle>(
  input: TableRowMutation,
  backend: TableMutationBackend<Handle>,
) {
  // Capture command identity before asynchronous reads; a caller navigating or
  // replacing a draft must not retarget an operation already in flight.
  const target = { ...input.target, scope: { ...input.target.scope } };
  const baseline = input.baseline && { ...input.baseline };
  const command: TableRowMutation =
    input.kind === 'delete'
      ? { ...input, target, baseline }
      : {
          ...input,
          target,
          baseline,
          changes:
            typeof input.changes === 'function'
              ? input.changes
              : { ...input.changes },
        };
  if (
    command.schemaRevision !== undefined &&
    command.schemaRevision !== backend.schema.revision
  )
    throw new TableMutationError(
      'schema',
      'The schema changed. Your draft is retained.',
    );
  const columns = new Map(
    backend.schema.columns.map(column => [column.id, column]),
  );
  if (columns.size !== backend.schema.columns.length)
    throw new TableMutationError(
      'schema',
      'Duplicate field identities in the mutation schema',
    );
  const current = await backend.read(command.target);
  if (!current)
    throw new TableMutationError(
      'missing-row',
      'Record is no longer in this collection. Your draft is retained.',
    );

  try {
    if (!sameTableMutationTarget(command.target, current.target))
      throw new TableMutationError(
        'scope',
        'Record is no longer in this collection. Your draft is retained.',
      );
    const values = Object.freeze({ ...current.values });
    const changes =
      command.kind === 'delete'
        ? {}
        : {
            ...(typeof command.changes === 'function'
              ? command.changes(values)
              : command.changes),
          };
    const keys =
      command.kind === 'delete' ? [...columns.keys()] : Object.keys(changes);
    const equals = backend.equals ?? Object.is;

    for (const key of keys) {
      const column = columns.get(key);
      if (!column || (command.kind === 'update' && !column.writable))
        throw new TableMutationError('field', 'Unknown or read-only column');
      if (
        command.baseline &&
        (!Object.hasOwn(command.baseline, key) ||
          !equals(values[key], command.baseline[key], key))
      )
        throw new TableMutationError(
          'conflict',
          `${column.label ?? key} changed elsewhere. Your draft is retained.`,
        );
    }

    if (command.kind === 'update')
      await backend.validate?.(current, { ...values, ...changes });
    if (
      command.schemaRevision !== undefined &&
      command.schemaRevision !== backend.schema.revision
    )
      throw new TableMutationError(
        'schema',
        'The schema changed. Your draft is retained.',
      );
    await backend.write(current, command, changes);
    const confirmed = await backend.read(command.target);

    try {
      const valid =
        command.kind === 'delete'
          ? confirmed === undefined
          : confirmed !== undefined &&
            sameTableMutationTarget(command.target, confirmed.target) &&
            keys.every(key => equals(confirmed.values[key], changes[key], key));
      if (!valid)
        throw new TableMutationError(
          'confirmation',
          'The backend read did not confirm the write. Your draft is retained.',
        );
    } finally {
      if (confirmed) backend.release?.(confirmed);
    }
  } finally {
    backend.release?.(current);
  }
}
