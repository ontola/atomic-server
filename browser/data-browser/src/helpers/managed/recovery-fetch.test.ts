// @wc-ignore-file
import { beforeEach, expect, it, vi } from 'vitest';
import { getRecoverySecret } from './recovery';
import { getManagedAccount } from './session';
import { managedFetch, getManagedApiBase } from './api';

vi.mock('./session', () => ({ getManagedAccount: vi.fn() }));
vi.mock('./api', () => ({ managedFetch: vi.fn(), getManagedApiBase: vi.fn() }));

beforeEach(() => {
  vi.mocked(getManagedAccount).mockResolvedValue({ email: 'one@example.com' });
  vi.mocked(getManagedApiBase).mockReturnValue('https://portal.example/api');
  vi.mocked(managedFetch).mockReset();
});

it('shares concurrent recovery reads without caching settled responses', async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(managedFetch).mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const first = getRecoverySecret();
  const second = getRecoverySecret();
  await vi.waitFor(() => expect(managedFetch).toHaveBeenCalledTimes(1));
  resolve(new Response(null, { status: 204 }));
  expect(await Promise.all([first, second])).toEqual([null, null]);
  vi.mocked(managedFetch).mockResolvedValue(
    new Response(null, { status: 204 }),
  );
  await getRecoverySecret();
  expect(managedFetch).toHaveBeenCalledTimes(2);
});

it('does not share reads between accounts or API origins', async () => {
  const resolve: ((response: Response) => void)[] = [];
  vi.mocked(managedFetch).mockImplementation(
    () =>
      new Promise(done => {
        resolve.push(done);
      }),
  );
  const first = getRecoverySecret();
  await vi.waitFor(() => expect(managedFetch).toHaveBeenCalledTimes(1));
  vi.mocked(getManagedAccount).mockResolvedValue({ email: 'two@example.com' });
  const second = getRecoverySecret();
  await vi.waitFor(() => expect(managedFetch).toHaveBeenCalledTimes(2));
  vi.mocked(getManagedApiBase).mockReturnValue('https://other.example/api');
  const third = getRecoverySecret();
  await vi.waitFor(() => expect(managedFetch).toHaveBeenCalledTimes(3));
  resolve.forEach(done => done(new Response(null, { status: 204 })));
  await Promise.all([first, second, third]);
});

it('retries a failed read and makes no request while signed out', async () => {
  vi.mocked(managedFetch).mockRejectedValueOnce(new Error('offline'));
  await expect(getRecoverySecret()).rejects.toThrow('offline');
  vi.mocked(managedFetch).mockResolvedValue(
    new Response(null, { status: 204 }),
  );
  expect(await getRecoverySecret()).toBeNull();
  vi.mocked(getManagedAccount).mockResolvedValue(null);
  expect(await getRecoverySecret()).toBeNull();
  expect(managedFetch).toHaveBeenCalledTimes(2);
});
