import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Store, core } from '@tomic/react';
import { runViewQuery } from '@helpers/extensions/viewQuery';
import { handleRequest } from './hostStore';
import { hostedLitewriteStorage } from './hostedLitewriteStorage';

vi.mock('@helpers/extensions/viewQuery', async importOriginal => ({
  ...await importOriginal<typeof import('@helpers/extensions/viewQuery')>(),
  runViewQuery: vi.fn(),
}));
vi.mock('./hostStore', () => ({ handleRequest: vi.fn() }));

const drive = 'https://atomic.example/drive';
const app = drive + '/litewrite';
const table = app + '/notes';
const rowClass = app + '/Note';
const key = '6a6f429c-2262-4d28-bb86-a0e5507062aa';
const note = {
  id: key,
  title: 'A note',
  content: 'Test',
  lastEdited: 1,
  cursorPos: 0,
  public: null,
};
const row = (subject: string, parent: string, document = note) => {
  const properties: Record<string, unknown> = {
    [core.properties.parent]: parent,
    [core.properties.shortname]: document.id,
    [core.properties.description]: 'litewrite-note/v1\n' + JSON.stringify(document),
  };
  return { subject, get: (property: string) => properties[property], hasClasses: () => true };
};
const resources = new Map([
  [table, row(table, app)],
  [table + '/one', row(table + '/one', table)],
  [drive + '/outside', row(drive + '/outside', drive)],
]);
const store = {
  getResource: async (subject: string) => resources.get(subject),
} as unknown as Store;

beforeEach(() => {
  vi.mocked(handleRequest).mockReset().mockResolvedValue({ table, rowClass });
  vi.mocked(runViewQuery).mockReset().mockResolvedValue([table + '/one', drive + '/outside']);
});

describe('hosted Litewrite storage', () => {
  it('returns only notes directly inside the installation table', async () => {
    const answer = hostedLitewriteStorage(store, app, drive, () => true);
    expect(await answer({ id: 1, op: 'list' })).toEqual({ [key]: note });
    expect(runViewQuery).toHaveBeenCalledWith(store, expect.objectContaining({
      property: core.properties.parent,
      value: table,
    }));
  });

  it('resolves the subject on the host before passing a write to the app writer', async () => {
    const answer = hostedLitewriteStorage(store, app, drive, () => true);
    await answer({ id: 1, op: 'put', key, note: { ...note, content: 'Updated' } });
    expect(handleRequest).toHaveBeenLastCalledWith(store, app, drive, expect.objectContaining({
      op: 'save',
      subject: table + '/one',
    }));
  });

  it('refuses an installation table owned by another app', async () => {
    vi.mocked(handleRequest).mockResolvedValue({ table: drive + '/outside', rowClass });
    const answer = hostedLitewriteStorage(store, app, drive, () => true);
    await expect(answer({ id: 1, op: 'list' })).rejects.toThrow('own app table');
    expect(runViewQuery).not.toHaveBeenCalled();
  });

  it('refuses work on a closed session', async () => {
    const answer = hostedLitewriteStorage(store, app, drive, () => false);
    await expect(answer({ id: 1, op: 'delete', key })).rejects.toThrow('session ended');
    expect(handleRequest).not.toHaveBeenCalled();
  });
});
