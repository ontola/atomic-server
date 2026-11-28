import { afterEach, expect, it, vi } from 'vitest';
import { dataBrowser, type Store } from '@tomic/lib';
import { resizeImageFile } from '@tomic/resource-ui/helpers/resizeImage';
import { installIntegrationIcon } from './installIntegrationIcon';

vi.mock('@tomic/resource-ui/helpers/resizeImage', () => ({
  resizeImageFile: vi.fn(async file => file),
}));
afterEach(() => vi.restoreAllMocks());

function fixture(existing?: string) {
  const resource = {
    get: vi.fn(() => existing),
    set: vi.fn(),
    save: vi.fn(),
  };
  const store = {
    getResource: vi.fn(async () => resource),
    uploadFiles: vi.fn(async () => ['saved-icon']),
  };
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response('image bytes', { headers: { 'Content-Type': 'image/png' } }),
    );

  return { store: store as unknown as Store, resource, fetch };
}

it('stores a resized provider image as a file inside the app without credentials', async () => {
  const { store, resource, fetch } = fixture();
  await installIntegrationIcon(
    store,
    'app',
    'https://assets.example/icon.png',
    new AbortController().signal,
  );
  expect(fetch).toHaveBeenCalledWith(
    new URL('https://assets.example/icon.png'),
    expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
  );
  expect(resizeImageFile).toHaveBeenCalledWith(expect.any(File), {
    maxSize: 128,
    square: true,
  });
  expect(store.uploadFiles).toHaveBeenCalledWith([expect.any(File)], 'app');
  expect(resource.set).toHaveBeenCalledWith(
    dataBrowser.properties.icon,
    'saved-icon',
  );
  expect(resource.save).toHaveBeenCalledOnce();
});

it('preserves a person’s existing icon and skips missing branding', async () => {
  const { store, fetch } = fixture('custom-icon');
  await installIntegrationIcon(
    store,
    'app',
    'https://assets.example/icon.png',
    new AbortController().signal,
  );
  await installIntegrationIcon(
    store,
    'app',
    undefined,
    new AbortController().signal,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(store.uploadFiles).not.toHaveBeenCalled();
});

it('refuses unsafe URLs, unexpected content and oversized streamed images before writing', async () => {
  const { store, fetch, resource } = fixture();

  for (const url of [
    'javascript:alert(1)',
    'http://public.example/icon.png',
    'https://user:password@assets.example/icon.png',
  ]) {
    await expect(
      installIntegrationIcon(store, 'app', url, new AbortController().signal),
    ).rejects.toThrow();
  }

  expect(fetch).not.toHaveBeenCalled();

  for (const response of [
    new Response('html', { headers: { 'Content-Type': 'text/html' } }),
    new Response('x'.repeat(262_145), {
      headers: { 'Content-Type': 'image/png' },
    }),
    new Response('', { status: 503 }),
  ]) {
    fetch.mockResolvedValue(response);
    await expect(
      installIntegrationIcon(
        store,
        'app',
        'https://assets.example/icon.png',
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }

  expect(resource.set).not.toHaveBeenCalled();
  expect(store.uploadFiles).not.toHaveBeenCalled();
});

it('does not upload late branding after cancellation', async () => {
  const { store, fetch } = fixture();
  const controller = new AbortController();
  fetch.mockImplementation(async () => {
    controller.abort();

    return new Response('image', { headers: { 'Content-Type': 'image/png' } });
  });
  await expect(
    installIntegrationIcon(
      store,
      'app',
      'https://assets.example/icon.png',
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(store.uploadFiles).not.toHaveBeenCalled();
});

it('preserves an icon chosen while the downloaded image was being installed', async () => {
  const { store, resource } = fixture();
  vi.mocked(store.uploadFiles).mockImplementation(async () => {
    resource.get.mockReturnValue('custom-icon');

    return ['downloaded-icon'];
  });
  await installIntegrationIcon(
    store,
    'app',
    'https://assets.example/icon.png',
    new AbortController().signal,
  );
  expect(resource.set).not.toHaveBeenCalled();
});
