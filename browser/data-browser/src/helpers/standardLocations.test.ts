// @wc-ignore-file
import { expect, it, vi } from 'vitest';
import {
  Agent,
  AtomicError,
  ErrorType,
  ai,
  core,
  dataBrowser,
  type Store,
} from '@tomic/lib';
import { getOrCreateAiChatsFolder } from './standardLocations';

const secret = Agent.buildSecret(
  btoa('test-only-ai-folder-seed'.padEnd(32, '.')),
  'did:ad:agent:test',
);

function device() {
  const agent = Agent.fromSecret(secret, 'js');
  const resources = new Map<string, ReturnType<typeof resource>>();

  function resource(subject: string, isFolder = false) {
    const props = new Map<string, unknown>();

    return {
      subject,
      error: undefined as Error | undefined,
      get: (prop: string) => props.get(prop),
      set: vi.fn(async (prop: string, value: unknown) => {
        props.set(prop, value);
      }),
      save: vi.fn(async () => {}),
      hasClasses: (cls: string) =>
        isFolder && cls === dataBrowser.classes.folder,
    };
  }

  resources.set('did:ad:drive', resource('did:ad:drive'));
  const store = {
    getAgent: () => agent,
    isDestroyed: vi.fn(() => false),
    getResource: vi.fn(
      async (subject: string) =>
        resources.get(subject) ?? {
          error: new AtomicError('Missing', ErrorType.NotFound),
        },
    ),
    newResource: vi.fn(async (options: { subject: string }) => {
      const folder = resource(options.subject, true);
      resources.set(folder.subject, folder);

      return folder;
    }),
    notifyResourceManuallyCreated: vi.fn(),
  };

  return { agent, resources, store, typed: store as unknown as Store };
}

it('two devices racing and concurrent callers on each create the same folder', async () => {
  const phone = device();
  const desktop = device();
  const ids = await Promise.all(
    [phone, phone, desktop, desktop].map(d =>
      getOrCreateAiChatsFolder(d.typed, 'did:ad:drive'),
    ),
  );
  expect(new Set(ids).size).toBe(1);

  for (const d of [phone, desktop]) {
    expect(d.store.newResource).toHaveBeenCalledTimes(1);
    expect(
      d.resources.get('did:ad:drive')?.get(ai.properties.aiChatsFolder),
    ).toBe(ids[0]);
    await d.resources.get(ids[0])!.set(core.properties.name, 'Renamed');
    expect(await getOrCreateAiChatsFolder(d.typed, 'did:ad:drive')).toBe(
      ids[0],
    );
    expect(d.resources.get(ids[0])?.get(core.properties.name)).toBe('Renamed');
  }
});

it('does not resurrect a deleted deterministic folder or mint a random replacement', async () => {
  const d = device();
  d.store.isDestroyed.mockReturnValue(true);
  await expect(
    getOrCreateAiChatsFolder(d.typed, 'did:ad:drive'),
  ).rejects.toThrow('deleted');
  expect(d.store.newResource).not.toHaveBeenCalled();
});

it('does not initialize over a transport failure', async () => {
  const d = device();
  const folder = await d.agent.aiChatsFolderSubject('did:ad:drive');
  d.resources.set(folder, {
    error: new AtomicError('Unavailable', ErrorType.Transport),
  } as never);
  await expect(
    getOrCreateAiChatsFolder(d.typed, 'did:ad:drive'),
  ).rejects.toThrow('Unavailable');
  expect(d.store.newResource).not.toHaveBeenCalled();
});

it('keeps an old session working with its existing folder, but never creates a random fallback', async () => {
  const d = device();
  const folder = await getOrCreateAiChatsFolder(d.typed, 'did:ad:drive');
  vi.spyOn(d.agent, 'aiChatsFolderSubject').mockRejectedValue(
    new Error('Sign in again'),
  );
  expect(await getOrCreateAiChatsFolder(d.typed, 'did:ad:drive')).toBe(folder);
  await d.resources
    .get('did:ad:drive')!
    .set(ai.properties.aiChatsFolder, undefined);
  await expect(
    getOrCreateAiChatsFolder(d.typed, 'did:ad:drive'),
  ).rejects.toThrow('Sign in again');
  expect(d.store.newResource).toHaveBeenCalledTimes(1);
});
