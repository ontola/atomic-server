import { expect, it, vi } from 'vitest';
import {
  executeTableRowCreation,
  type TableCreationBackend,
} from './creation.js';

function setup() {
  const command = {
    scope: { collection: 'table', rowClass: 'class', graph: 'graph' },
    schemaRevision: 'v1',
    values: { quantity: 0, complete: false },
  };
  const row = {
    target: { subject: 'row', scope: { ...command.scope } },
    values: { ...command.values, optional: undefined },
    handle: 'draft',
  };
  const confirmed = { ...row, handle: 'confirmation' };
  const backend: TableCreationBackend<string> = {
    schema: { revision: 'v1' },
    prepare: vi.fn(async () => row),
    validate: vi.fn(),
    persist: vi.fn(async () => {}),
    read: vi.fn(async () => confirmed),
    release: vi.fn(),
  };

  return { command, row, confirmed, backend };
}

it('confirms defaults, zero, false and absent optional values, then releases both handles', async () => {
  const { command, row, confirmed, backend } = setup();
  await expect(executeTableRowCreation(command, backend)).resolves.toEqual(
    row.target,
  );
  expect(backend.validate).toHaveBeenCalledWith(row);
  expect(backend.persist).toHaveBeenCalledOnce();
  expect(backend.release).toHaveBeenNthCalledWith(1, confirmed);
  expect(backend.release).toHaveBeenNthCalledWith(2, row);
});

it('rejects stale schema before allocating an identity', async () => {
  const { command, backend } = setup();
  backend.schema.revision = 'v2';
  await expect(executeTableRowCreation(command, backend)).rejects.toMatchObject(
    { code: 'schema' },
  );
  expect(backend.prepare).not.toHaveBeenCalled();
});

for (const field of ['collection', 'rowClass', 'graph'] as const) {
  it(`rejects prepared rows in another ${field} before persistence`, async () => {
    const { command, row, backend } = setup();
    row.target.scope[field] = 'other';
    await expect(
      executeTableRowCreation(command, backend),
    ).rejects.toMatchObject({ code: 'scope' });
    expect(backend.persist).not.toHaveBeenCalled();
    expect(backend.release).toHaveBeenCalledWith(row);
  });
}

it('rechecks the schema after asynchronous validation', async () => {
  const { command, backend } = setup();

  backend.validate = () => {
    backend.schema.revision = 'v2';
  };

  await expect(executeTableRowCreation(command, backend)).rejects.toMatchObject(
    { code: 'schema' },
  );
  expect(backend.persist).not.toHaveBeenCalled();
});

it('releases a rejected draft without writing or reading', async () => {
  const { command, row, backend } = setup();

  backend.validate = () => {
    throw Error('Invalid required value');
  };

  await expect(executeTableRowCreation(command, backend)).rejects.toThrow(
    'Invalid required value',
  );
  expect(backend.persist).not.toHaveBeenCalled();
  expect(backend.read).not.toHaveBeenCalled();
  expect(backend.release).toHaveBeenCalledWith(row);
});

it('does not retry a failed write or notify a successful creation', async () => {
  const { command, row, backend } = setup();
  backend.persist = vi.fn(async () => {
    throw Error('Write failed');
  });
  await expect(executeTableRowCreation(command, backend)).rejects.toThrow(
    'Write failed',
  );
  expect(backend.persist).toHaveBeenCalledOnce();
  expect(backend.read).not.toHaveBeenCalled();
  expect(backend.release).toHaveBeenCalledWith(row);
});

it('requires a separate read to confirm the prepared values', async () => {
  const { command, confirmed, backend } = setup();
  confirmed.values = { ...confirmed.values, quantity: 3 };
  await expect(executeTableRowCreation(command, backend)).rejects.toMatchObject(
    { code: 'confirmation' },
  );
  expect(backend.release).toHaveBeenCalledTimes(2);
});

it('rejects an absent confirmation and closes the draft', async () => {
  const { command, backend } = setup();
  backend.read = async () => undefined;
  await expect(executeTableRowCreation(command, backend)).rejects.toMatchObject(
    { code: 'confirmation' },
  );
  expect(backend.release).toHaveBeenCalledOnce();
});

it('captures command scope before navigation can mutate it', async () => {
  const { command, row, backend } = setup();

  backend.prepare = async snapshot => {
    command.scope.collection = 'other';
    command.values.quantity = 99;
    expect(snapshot.values.quantity).toBe(0);

    return row;
  };

  await expect(executeTableRowCreation(command, backend)).resolves.toEqual(
    row.target,
  );
});
