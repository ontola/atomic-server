import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { server, type Resource, type Store } from '@tomic/lib';
import { StoreContext } from './hooks.js';
import { useBlobObjectUrl, useFileObjectUrl } from './useFileObjectUrl.js';

const HASH = 'ab'.repeat(32);
const OTHER_HASH = 'cd'.repeat(32);
const BLOB = `atomic:blob:${HASH}`;
const OTHER_BLOB = `atomic:blob:${OTHER_HASH}`;
const FALLBACK = 'https://example.test/file';
const bytes = new Uint8Array([1, 2, 3]);
const createObjectURL = vi.fn((_blob: Blob) => 'blob:recovered');
const revokeObjectURL = vi.fn();

function makeDb() {
  return {
    getBlob: vi.fn(
      async (_hash: Uint8Array): Promise<Uint8Array | undefined> => undefined,
    ),
  };
}

function fixture({ native = false, provider = true } = {}) {
  const state = {
    db: native ? undefined : makeDb(),
    drive: 'atomic:drive:first',
    agent: 'atomic:agent:first',
    provider,
  };
  const recover = vi.fn(async (_hash: string, _drive?: string) => false);
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const listener of listeners) listener();
  };

  const store = {
    getClientDb: () => state.db,
    getDrive: () => state.drive,
    getAgent: () => ({ subject: state.agent }),
    hasFileContentRecovery: () => state.provider,
    recoverMissingFileContents: recover,
    onFileContentRecoveryChanged: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  } as unknown as Store;
  const wrapper = ({ children }: { children?: ReactNode }) =>
    createElement(StoreContext.Provider, { value: store }, children);

  return { state, recover, wrapper, changed };
}

function Preview({ blob = BLOB, drive }: { blob?: string; drive?: string }) {
  const url = useBlobObjectUrl(blob, FALLBACK, 'image/png', drive);

  return createElement('output', { 'data-testid': 'url' }, url ?? 'waiting');
}

beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('recovers a cache miss and updates the same mounted preview from the reread bytes', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<boolean>();
  f.recover.mockReturnValue(pending.promise);
  const view = render(createElement(Preview), { wrapper: f.wrapper });
  expect(screen.getByTestId('url').textContent).toBe('waiting');
  await waitFor(() => expect(f.recover).toHaveBeenCalledWith(HASH, undefined));
  const mounted = screen.getByTestId('url');
  f.state.db!.getBlob.mockResolvedValue(bytes);
  await act(async () => pending.resolve(true));
  await waitFor(() => expect(mounted.textContent).toBe('blob:recovered'));
  expect(screen.getByTestId('url')).toBe(mounted);
  expect(f.state.db!.getBlob).toHaveBeenCalledTimes(2);
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(createObjectURL.mock.calls[0][0].type).toBe('image/png');

  view.unmount();
  render(createElement(Preview), { wrapper: f.wrapper });
  expect(screen.getByTestId('url').textContent).toBe('blob:recovered');
  expect(f.recover).toHaveBeenCalledOnce();
  expect(f.state.db!.getBlob).toHaveBeenCalledTimes(2);
  expect(createObjectURL).toHaveBeenCalledOnce();
});

it('passes the File resource’s drive as the recovery hint', async () => {
  const f = fixture();
  const resource = {
    get: (property: string) => {
      if (property === 'https://atomicdata.dev/properties/blob') return BLOB;
      if (property === 'https://atomicdata.dev/properties/drive')
        return 'atomic:drive:file';
      if (property === server.properties.mimetype) return 'image/png';
    },
  } as unknown as Resource;
  const FilePreview = () =>
    createElement('output', null, useFileObjectUrl(resource, FALLBACK));
  render(createElement(FilePreview), { wrapper: f.wrapper });
  await waitFor(() =>
    expect(f.recover).toHaveBeenCalledWith(HASH, 'atomic:drive:file'),
  );
});

it('settles on the fallback after failed recovery without polling on rerender', async () => {
  const f = fixture();
  const view = render(createElement(Preview), { wrapper: f.wrapper });
  await waitFor(() =>
    expect(screen.getByTestId('url').textContent).toBe(FALLBACK),
  );
  expect(f.state.db!.getBlob).toHaveBeenCalledTimes(2);
  view.rerender(createElement(Preview));
  expect(f.recover).toHaveBeenCalledOnce();
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('retries a mounted missing preview when recovery becomes available', async () => {
  const f = fixture({ provider: false });
  render(createElement(Preview), { wrapper: f.wrapper });
  await waitFor(() =>
    expect(screen.getByTestId('url').textContent).toBe(FALLBACK),
  );
  expect(f.state.db!.getBlob).toHaveBeenCalledOnce();
  expect(f.recover).not.toHaveBeenCalled();
  f.recover.mockImplementation(async () => {
    f.state.db!.getBlob.mockResolvedValue(bytes);

    return true;
  });
  act(() => {
    f.state.provider = true;
    f.changed();
  });
  await waitFor(() =>
    expect(screen.getByTestId('url').textContent).toBe('blob:recovered'),
  );
  expect(f.recover).toHaveBeenCalledOnce();
});

it('retries a failed preview on an explicit recovery change but preserves a successful cache', async () => {
  const f = fixture();
  render(createElement(Preview), { wrapper: f.wrapper });
  await waitFor(() =>
    expect(screen.getByTestId('url').textContent).toBe(FALLBACK),
  );
  f.recover.mockImplementation(async () => {
    f.state.db!.getBlob.mockResolvedValue(bytes);

    return true;
  });
  act(() => f.changed());
  await waitFor(() =>
    expect(screen.getByTestId('url').textContent).toBe('blob:recovered'),
  );
  expect(f.recover).toHaveBeenCalledTimes(2);
  act(() => f.changed());
  expect(screen.getByTestId('url').textContent).toBe('blob:recovered');
  expect(f.recover).toHaveBeenCalledTimes(2);
  expect(createObjectURL).toHaveBeenCalledOnce();
});

it('uses already-present bytes without asking the recovery service', async () => {
  const f = fixture();
  f.state.db!.getBlob.mockResolvedValue(bytes);
  render(createElement(Preview), { wrapper: f.wrapper });
  await waitFor(() =>
    expect(screen.getByTestId('url').textContent).toBe('blob:recovered'),
  );
  expect(f.recover).not.toHaveBeenCalled();
});

it('does not make an object URL from an old resource’s late recovery', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<boolean>();
  f.recover.mockImplementation(hash =>
    hash === HASH ? pending.promise : Promise.resolve(false),
  );
  const view = render(createElement(Preview), { wrapper: f.wrapper });
  await waitFor(() => expect(f.recover).toHaveBeenCalledOnce());
  view.rerender(createElement(Preview, { blob: OTHER_BLOB }));
  await waitFor(() =>
    expect(screen.getByTestId('url').textContent).toBe(FALLBACK),
  );
  f.state.db!.getBlob.mockResolvedValue(bytes);
  await act(async () => pending.resolve(true));
  expect(screen.getByTestId('url').textContent).toBe(FALLBACK);
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('does not use a previous database’s late recovery in the new database', async () => {
  const f = fixture();
  const firstDb = f.state.db!;
  const pending = Promise.withResolvers<boolean>();
  f.recover.mockReturnValueOnce(pending.promise);
  const view = render(createElement(Preview), { wrapper: f.wrapper });
  await waitFor(() => expect(f.recover).toHaveBeenCalledOnce());
  f.state.db = makeDb();
  view.rerender(createElement(Preview));
  await waitFor(() =>
    expect(screen.getByTestId('url').textContent).toBe(FALLBACK),
  );
  firstDb.getBlob.mockResolvedValue(bytes);
  await act(async () => pending.resolve(true));
  expect(screen.getByTestId('url').textContent).toBe(FALLBACK);
  expect(firstDb.getBlob).toHaveBeenCalledOnce();
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('ignores a late recovery after the selected drive changes', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<boolean>();
  f.recover.mockReturnValueOnce(pending.promise);
  const view = render(createElement(Preview), { wrapper: f.wrapper });
  await waitFor(() => expect(f.recover).toHaveBeenCalledOnce());
  f.state.drive = 'atomic:drive:second';
  view.rerender(createElement(Preview));
  await waitFor(() =>
    expect(screen.getByTestId('url').textContent).toBe(FALLBACK),
  );
  f.state.db!.getBlob.mockResolvedValue(bytes);
  await act(async () => pending.resolve(true));
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('does not create an object URL after the preview unmounts', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<boolean>();
  f.recover.mockReturnValueOnce(pending.promise);
  const view = render(createElement(Preview), { wrapper: f.wrapper });
  await waitFor(() => expect(f.recover).toHaveBeenCalledOnce());
  view.unmount();
  f.state.db!.getBlob.mockResolvedValue(bytes);
  await act(async () => pending.resolve(true));
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('waits for native recovery before exposing the existing download URL', async () => {
  const f = fixture({ native: true });
  const pending = Promise.withResolvers<boolean>();
  f.recover.mockReturnValue(pending.promise);
  render(createElement(Preview), { wrapper: f.wrapper });
  expect(screen.getByTestId('url').textContent).toBe('waiting');
  await waitFor(() => expect(f.recover).toHaveBeenCalledWith(HASH, undefined));
  await act(async () => pending.resolve(true));
  await waitFor(() =>
    expect(screen.getByTestId('url').textContent).toBe(FALLBACK),
  );
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('returns the native fallback immediately when no provider exists', () => {
  const f = fixture({ native: true, provider: false });
  render(createElement(Preview), { wrapper: f.wrapper });
  expect(screen.getByTestId('url').textContent).toBe(FALLBACK);
  expect(f.recover).not.toHaveBeenCalled();
});

it('keeps server output pending for local lookups and immediate for native fallback', () => {
  const local = fixture();
  const native = fixture({ native: true, provider: false });
  expect(
    renderToString(createElement(local.wrapper, null, createElement(Preview))),
  ).toContain('waiting');
  expect(
    renderToString(createElement(native.wrapper, null, createElement(Preview))),
  ).toContain(FALLBACK);
  expect(local.recover).not.toHaveBeenCalled();
});
