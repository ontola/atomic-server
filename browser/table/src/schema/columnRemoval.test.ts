import { expect, it, vi } from 'vitest';
import { executeTableColumnRemoval } from './columnRemoval.js';
const allowed = {
  canRemove: true,
  canDeleteDefinition: true,
  deleteDefinition: false,
};
it('detaches by default without deleting the property definition', async () => {
  const backend = { removeFromSchema: vi.fn(), deleteDefinition: vi.fn() };
  await executeTableColumnRemoval(allowed, backend);
  expect(backend.removeFromSchema).toHaveBeenCalledOnce();
  expect(backend.deleteDefinition).not.toHaveBeenCalled();
});
it('requires explicit authorized deletion and waits for detachment', async () => {
  let confirm!: () => void;
  const backend = {
    removeFromSchema: vi.fn(
      () =>
        new Promise<void>(resolve => {
          confirm = resolve;
        }),
    ),
    deleteDefinition: vi.fn(),
  };
  const pending = executeTableColumnRemoval(
    { ...allowed, deleteDefinition: true },
    backend,
  );
  expect(backend.deleteDefinition).not.toHaveBeenCalled();
  confirm();
  await pending;
  expect(backend.deleteDefinition).toHaveBeenCalledOnce();
});
it('rejects unavailable intents before either write', async () => {
  for (const intent of [
    { ...allowed, canRemove: false },
    { ...allowed, deleteDefinition: true, canDeleteDefinition: false },
  ]) {
    const backend = { removeFromSchema: vi.fn(), deleteDefinition: vi.fn() };
    await expect(executeTableColumnRemoval(intent, backend)).rejects.toThrow(
      'unavailable',
    );
    expect(backend.removeFromSchema).not.toHaveBeenCalled();
    expect(backend.deleteDefinition).not.toHaveBeenCalled();
  }
});
it('does not delete after failed detachment and surfaces a deletion failure', async () => {
  const backend = {
    removeFromSchema: vi.fn().mockRejectedValue(Error('detach failed')),
    deleteDefinition: vi.fn(),
  };
  await expect(
    executeTableColumnRemoval({ ...allowed, deleteDefinition: true }, backend),
  ).rejects.toThrow('detach failed');
  expect(backend.deleteDefinition).not.toHaveBeenCalled();
  backend.removeFromSchema.mockResolvedValue(undefined);
  backend.deleteDefinition.mockRejectedValue(Error('delete failed'));
  await expect(
    executeTableColumnRemoval({ ...allowed, deleteDefinition: true }, backend),
  ).rejects.toThrow('delete failed');
});
it('captures the submitted flag instead of allowing a later mutation to escalate deletion', async () => {
  let confirm!: () => void;
  const intent = { ...allowed, canDeleteDefinition: false };
  const backend = {
    removeFromSchema: () =>
      new Promise<void>(resolve => {
        confirm = resolve;
      }),
    deleteDefinition: vi.fn(),
  };
  const pending = executeTableColumnRemoval(intent, backend);
  intent.deleteDefinition = true;
  confirm();
  await pending;
  expect(backend.deleteDefinition).not.toHaveBeenCalled();
});
