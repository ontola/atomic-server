import { expect, it, vi } from 'vitest';
import {
  executeTableRowMutation,
  clearTableFields,
  type TableMutationBackend,
  type TableRowMutation,
} from './mutations.js';

const target = {
  subject: 'row:one',
  scope: { collection: 'table:one', rowClass: 'class:row', graph: 'graph:one' },
};
const field = 'property:quantity';

function setup() {
  let values: Record<string, unknown> | undefined = {
    [field]: 1,
    'property:locked': 'kept',
    'property:optional': 'old',
  };
  const release = vi.fn();
  const backend: TableMutationBackend<number> = {
    schema: {
      revision: 'schema:1',
      columns: [
        { id: field, label: 'Quantity', writable: true },
        { id: 'property:locked', writable: false },
        { id: 'property:optional', writable: true },
      ],
    },
    read: vi.fn(async () =>
      values ? { target, values: { ...values }, handle: 1 } : undefined,
    ),
    write: vi.fn(async (_, command, changes) => {
      values =
        command.kind === 'delete' ? undefined : { ...values, ...changes };
    }),
    validate: vi.fn(),
    release,
  };
  const command: TableRowMutation = {
    target: structuredClone(target),
    schemaRevision: 'schema:1',
    kind: 'update',
    baseline: { [field]: 1 },
    changes: { [field]: 0 },
  };

  return { backend, command, release };
}

it('checks the baseline, validates, writes and reads back before reporting success', async () => {
  const { backend, command, release } = setup();
  await executeTableRowMutation(command, backend);
  expect(backend.validate).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ [field]: 0, 'property:locked': 'kept' }),
  );
  expect(backend.write).toHaveBeenCalledTimes(1);
  expect(backend.read).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledTimes(2);
  expect(command.baseline).toEqual({ [field]: 1 });
});

it.each(['property:locked', 'property:unknown'])(
  'rejects non-writable or unknown field %s',
  async id => {
    const { backend, command, release } = setup();
    await expect(
      executeTableRowMutation(
        { ...command, kind: 'update', changes: { [id]: 'no' } },
        backend,
      ),
    ).rejects.toMatchObject({ code: 'field' });
    expect(backend.write).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  },
);

it.each([{}, { [field]: 2 }])(
  'retains commands with missing or stale baselines',
  async baseline => {
    const { backend, command } = setup();
    await expect(
      executeTableRowMutation({ ...command, baseline }, backend),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(backend.write).not.toHaveBeenCalled();
  },
);

it.each(['collection', 'rowClass', 'graph'] as const)(
  'rejects a row returned outside the requested %s',
  async dimension => {
    const { backend, command } = setup();
    backend.read = async () => ({
      target: { ...target, scope: { ...target.scope, [dimension]: 'other' } },
      values: { [field]: 1 },
      handle: 1,
    });
    await expect(
      executeTableRowMutation(command, backend),
    ).rejects.toMatchObject({ code: 'scope' });
    expect(backend.write).not.toHaveBeenCalled();
  },
);

it('releases reads when backend validation rejects, without writing', async () => {
  const { backend, command, release } = setup();

  backend.validate = async () => {
    throw Error('Required value');
  };

  await expect(executeTableRowMutation(command, backend)).rejects.toThrow(
    'Required value',
  );
  expect(backend.write).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it('rejects a schema change during preflight', async () => {
  const { backend, command } = setup();

  backend.validate = () => {
    backend.schema.revision = 'schema:2';
  };

  await expect(executeTableRowMutation(command, backend)).rejects.toMatchObject(
    { code: 'schema' },
  );
  expect(backend.write).not.toHaveBeenCalled();
});

it('does not report confirmation when the backend keeps the previous value', async () => {
  const { backend, command, release } = setup();
  backend.write = vi.fn(async () => {});
  await expect(executeTableRowMutation(command, backend)).rejects.toMatchObject(
    { code: 'confirmation' },
  );
  expect(release).toHaveBeenCalledTimes(2);
});

it('preserves zero, false and clearing as different values', async () => {
  const { backend } = setup();
  await executeTableRowMutation(
    {
      target,
      kind: 'update',
      changes: { [field]: false, 'property:optional': undefined },
    },
    backend,
  );
  expect(backend.write).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.anything(),
    { [field]: false, 'property:optional': undefined },
  );
});

it('checks the full schema baseline before deleting and requires an absent read-back', async () => {
  const { backend } = setup();
  await executeTableRowMutation(
    {
      target,
      kind: 'delete',
      baseline: {
        [field]: 1,
        'property:locked': 'kept',
        'property:optional': 'old',
      },
    },
    backend,
  );
  expect(backend.write).toHaveBeenCalledTimes(1);
});

it('captures the target before a caller changes its navigation state', async () => {
  const { backend, command } = setup();
  const read = backend.read;
  backend.read = vi.fn(async captured => {
    command.target.scope.collection = 'table:other';

    return read(captured);
  });
  await executeTableRowMutation(command, backend);
  expect(backend.write).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ target }),
    expect.anything(),
  );
});

it('clears several split languages without changing other languages or source data', () => {
  const values = {
    'property:label': { en: 'Hello', nl: 'Hallo', de: 'Hallo' },
    [field]: 0,
  };
  expect(
    clearTableFields(values, [
      { id: 'property:label', language: 'en' },
      { id: 'property:label', language: 'nl' },
    ]),
  ).toEqual({ 'property:label': { de: 'Hallo' } });
  expect(values['property:label']).toEqual({
    en: 'Hello',
    nl: 'Hallo',
    de: 'Hallo',
  });
  expect(
    clearTableFields(values, [{ id: 'property:label' }, { id: field }]),
  ).toEqual({ 'property:label': undefined, [field]: undefined });
});

it('passes stable property identities to typed baseline and read-back comparisons', async () => {
  const { backend, command } = setup();
  const equals = vi.fn((left: unknown, right: unknown, id: string) => {
    if (id === field && typeof left === 'number' && typeof right === 'number')
      return Math.fround(left) === Math.fround(right);

    return Object.is(left, right);
  });
  backend.equals = equals;
  backend.write = vi.fn(async () => {
    backend.read = vi.fn(async () => ({
      target,
      handle: 1,
      values: { [field]: 1.2345679 },
    }));
  });
  await executeTableRowMutation(
    { ...command, kind: 'update', changes: { [field]: 1.23456789 } },
    backend,
  );
  expect(equals).toHaveBeenCalledWith(1, 1, field);
  expect(equals).toHaveBeenCalledWith(1.2345679, 1.23456789, field);
  await expect(
    executeTableRowMutation(
      {
        ...command,
        kind: 'update',
        baseline: { 'property:optional': 16777217 },
        changes: { 'property:optional': 0 },
      },
      {
        ...backend,
        read: async () => ({
          target,
          handle: 1,
          values: { 'property:optional': 16777216 },
        }),
      },
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
});
