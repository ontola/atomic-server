import { afterEach, describe, expect, it, vi } from 'vitest';
import { healRefusedDrive } from './refusedDrive';
import { setManagedDeviceToken } from './api';

const DRIVE = 'did:ad:W2Q3';

function setup(local = false) {
  return {
    isLocalOnlyDrive: vi.fn(() => local),
    normalizeSubject: (subject: string) =>
      subject.replace(/^did:ad:/, 'atomic:'),
    makeDriveLocal: vi.fn(async () => {}),
  };
}

describe('a drive the node refuses as not enrolled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('moves to this browser when the account hosts nothing for it', async () => {
    const store = setup();

    expect(await healRefusedDrive(store, DRIVE, async () => [])).toBe(true);
    expect(store.makeDriveLocal).toHaveBeenCalledExactlyOnceWith(DRIVE);
  });

  it('ignores enrollments of other drives and disabled ones', async () => {
    const store = setup();

    expect(
      await healRefusedDrive(store, DRIVE, async () => [
        { drive_subject: 'did:ad:other', status: 'Active' },
        { drive_subject: DRIVE, status: 'Disabled' },
      ]),
    ).toBe(true);
    expect(store.makeDriveLocal).toHaveBeenCalledOnce();
  });

  it.each(['Active', 'Pending', 'Suspended', 'Error'])(
    'does not move a drive with a %s enrollment, wherever it is hosted',
    async status => {
      const store = setup();

      expect(
        await healRefusedDrive(store, DRIVE, async () => [
          // Spelled the other way: the refusal and the account may differ.
          { drive_subject: 'atomic:W2Q3', status },
        ]),
      ).toBe(false);
      expect(store.makeDriveLocal).not.toHaveBeenCalled();
    },
  );

  it('does not move a drive when the enrollment lookup fails', async () => {
    const store = setup();

    expect(
      await healRefusedDrive(store, DRIVE, async () => {
        throw new Error('Could not check Cloud Server hosting.');
      }),
    ).toBe(false);
    expect(store.makeDriveLocal).not.toHaveBeenCalled();
  });

  it('does not move a drive when nobody is signed in', async () => {
    vi.stubEnv('VITE_MANAGED_API_BASE', 'https://portal.example/api');
    setManagedDeviceToken(null);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/me'))
        return new Response(null, { status: 401 });

      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = setup();

    expect(await healRefusedDrive(store, DRIVE)).toBe(false);
    expect(store.makeDriveLocal).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('asks the control plane when signed in, and moves a drive it does not list', async () => {
    vi.stubEnv('VITE_MANAGED_API_BASE', 'https://portal.example/api');
    setManagedDeviceToken(null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.endsWith('/me')) return Response.json({ email: 'a@b.c' });
        if (url.endsWith('/sync-enrollments'))
          return Response.json([
            { drive_subject: 'did:ad:other', status: 'Active' },
          ]);

        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const store = setup();

    expect(await healRefusedDrive(store, DRIVE)).toBe(true);
    expect(store.makeDriveLocal).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('does not move a drive when the control plane cannot be reached', async () => {
    vi.stubEnv('VITE_MANAGED_API_BASE', 'https://portal.example/api');
    setManagedDeviceToken(null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.endsWith('/me')) return Response.json({ email: 'a@b.c' });

        return new Response('oops', { status: 502 });
      }),
    );
    const store = setup();

    expect(await healRefusedDrive(store, DRIVE)).toBe(false);
    expect(store.makeDriveLocal).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('leaves the refusal to be reported when the local copy cannot be verified', async () => {
    const store = setup();
    store.makeDriveLocal.mockRejectedValue(new Error('Sign in first'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await healRefusedDrive(store, DRIVE, async () => [])).toBe(false);
  });

  it('has nothing to do for a drive that is already browser-only', async () => {
    const store = setup(true);
    const lookup = vi.fn(async () => []);

    expect(await healRefusedDrive(store, DRIVE, lookup)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(store.makeDriveLocal).not.toHaveBeenCalled();
  });
});
