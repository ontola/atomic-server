import { beforeEach, describe, expect, it, vi } from 'vitest';
import { core, Datatype, type Store } from '@tomic/lib';
import { commitWebsiteField } from './websiteInlineEditing';
import { starterWebsite } from './websiteModel';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  private: vi.fn(),
  save: vi.fn(),
}));
vi.mock('./websiteModel', async importOriginal => ({
  ...(await importOriginal<typeof import('./websiteModel')>()),
  readWebsite: mocks.read,
  assertPrivateWebsiteParent: mocks.private,
  saveWebsiteResource: mocks.save,
}));

describe('inline website write boundary', () => {
  const set = vi.fn();
  const canWrite = vi.fn();
  let value: string;
  let datatype: string;
  let config: ReturnType<typeof starterWebsite>;
  const field = {
    subject: 'row',
    property: 'text',
    label: 'Name',
    original: 'Original',
  };
  const row = {
    set,
    canWrite,
    get: (property: string) =>
      property === core.properties.parent ? 'table' : value,
  };
  const store = {
    getDrive: () => 'drive',
    getAgent: () => ({ subject: 'author' }),
    getResource: async (subject: string) =>
      subject === 'row'
        ? row
        : subject === 'text'
          ? { get: () => datatype }
          : {},
  } as unknown as Store;
  beforeEach(() => {
    vi.clearAllMocks();
    value = 'Original';
    datatype = Datatype.STRING;
    canWrite.mockResolvedValue(true);
    mocks.private.mockResolvedValue(undefined);
    mocks.save.mockResolvedValue(undefined);
    config = starterWebsite();
    config.pages[0].tables = [
      {
        table: 'table',
        title: 'Notes',
        layout: 'grid',
        rows: ['row'],
        columns: [{ property: 'text', label: 'Name' }],
      },
    ];
    mocks.read.mockImplementation(async () => ({ config }));
  });
  it('writes to the existing selected source with the current author', async () => {
    await commitWebsiteField(store, 'site', field, 'Updated');
    expect(canWrite).toHaveBeenCalledWith('author');
    expect(mocks.private).toHaveBeenCalledWith(store, 'row');
    expect(set).toHaveBeenCalledWith('text', 'Updated');
    expect(mocks.save).toHaveBeenCalledWith(row);
  });
  it('refuses fields removed from the current website selection', async () => {
    config.pages[0].tables[0].columns = [];
    await expect(
      commitWebsiteField(store, 'site', field, 'Updated'),
    ).rejects.toThrow('no longer selected');
    expect(set).not.toHaveBeenCalled();
  });
  it('refuses revoked source rights, public content and non-text fields', async () => {
    canWrite.mockResolvedValue(false);
    await expect(
      commitWebsiteField(store, 'site', field, 'Updated'),
    ).rejects.toThrow('cannot edit');
    canWrite.mockResolvedValue(true);
    mocks.private.mockRejectedValueOnce(new Error('Public source'));
    await expect(
      commitWebsiteField(store, 'site', field, 'Updated'),
    ).rejects.toThrow('Public source');
    datatype = Datatype.INTEGER;
    await expect(
      commitWebsiteField(store, 'site', field, 'Updated'),
    ).rejects.toThrow('field type');
    expect(set).not.toHaveBeenCalled();
  });
  it('does not overwrite a concurrent edit or acknowledge an offline save', async () => {
    value = 'Changed elsewhere';
    await expect(
      commitWebsiteField(store, 'site', field, 'Updated'),
    ).rejects.toThrow('changed since');
    expect(set).not.toHaveBeenCalled();
    value = 'Original';
    mocks.save.mockRejectedValueOnce(new Error('pending locally'));
    await expect(
      commitWebsiteField(store, 'site', field, 'Updated'),
    ).rejects.toThrow('pending locally');
  });
});
