import { describe, expect, it, vi } from 'vitest';
import { server, type Resource } from '@tomic/lib';
import { setDriveListVisibility, visibleDrives } from './driveListManagement';

function index(saved: string[] = []) {
  const values = new Map<string, string[]>([[server.properties.drives, saved]]);
  const home = {
    subject: 'atomic:home',
    error: undefined as Error | undefined,
    isReady: () => true,
    getSubjects: (prop: string) => values.get(prop) ?? [],
    set: vi.fn(async (prop: string, value: string[]) => {
      values.set(prop, value);
    }),
    save: vi.fn(async () => {}),
  };

  return { home, resource: home as unknown as Resource, values };
}

describe('private drive list management', () => {
  it('removes broken and catalog-only pointers by editing only the private index', async () => {
    const { resource, home } = index([
      'atomic:home',
      'http://old.example/drive',
      'did:ad:project',
    ]);
    await setDriveListVisibility(
      resource,
      ['http://old.example/drive', 'atomic:project', 'atomic:catalog'],
      false,
    );
    expect(home.getSubjects(server.properties.drives)).toEqual(['atomic:home']);
    expect(home.getSubjects(server.properties.hiddenDrives)).toEqual([
      'http://old.example/drive',
      'atomic:project',
      'atomic:catalog',
    ]);
    expect(home.save).toHaveBeenCalledOnce();
    expect(home.set.mock.calls.map(([prop]) => prop)).toEqual([
      server.properties.drives,
      server.properties.hiddenDrives,
    ]);
  });

  it('protects the private drive including its old identifier spelling', async () => {
    const { resource, home } = index(['atomic:home']);
    await setDriveListVisibility(resource, ['did:ad:home'], false);
    expect(home.set).not.toHaveBeenCalled();
    expect(home.save).not.toHaveBeenCalled();
  });

  it('restores once, clearing both identifier spellings from the hidden list', async () => {
    const { resource, home, values } = index(['atomic:home', 'did:ad:project']);
    values.set(server.properties.hiddenDrives, [
      'atomic:project',
      'did:ad:project',
      'atomic:other',
    ]);
    await setDriveListVisibility(
      resource,
      ['did:ad:project', 'atomic:project'],
      true,
    );
    expect(home.getSubjects(server.properties.drives)).toEqual([
      'atomic:home',
      'atomic:project',
    ]);
    expect(home.getSubjects(server.properties.hiddenDrives)).toEqual([
      'atomic:other',
    ]);
  });

  it('serializes rapid actions so neither choice is lost', async () => {
    const { resource, home } = index(['atomic:first', 'atomic:second']);
    await Promise.all([
      setDriveListVisibility(resource, ['atomic:first'], false),
      setDriveListVisibility(resource, ['atomic:second'], false),
    ]);
    expect(home.getSubjects(server.properties.hiddenDrives)).toEqual([
      'atomic:first',
      'atomic:second',
    ]);
    expect(home.getSubjects(server.properties.drives)).toEqual([]);
  });

  it('reports an unavailable private index without editing it and permits a later retry', async () => {
    const { resource, home } = index(['atomic:project']);
    home.error = new Error('Unavailable');
    await expect(
      setDriveListVisibility(resource, ['atomic:project'], false),
    ).rejects.toThrow('finish loading');
    expect(home.set).not.toHaveBeenCalled();
    home.error = undefined;
    await setDriveListVisibility(resource, ['atomic:project'], false);
    expect(home.getSubjects(server.properties.drives)).toEqual([]);
  });

  it('filters alias references without conflating distinct HTTP origins', () => {
    expect(
      visibleDrives(
        [
          'did:ad:project',
          'http://old.example/drive',
          'https://old.example/drive',
        ],
        ['atomic:project', 'http://old.example/drive'],
      ),
    ).toEqual(['https://old.example/drive']);
  });
});
