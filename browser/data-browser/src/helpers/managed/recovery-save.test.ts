// @wc-ignore-file
import { beforeEach, expect, it, vi } from 'vitest';
import { saveRecoverySecret, type RecoverySecretInput } from './recovery';
import {
  getManagedApiBase,
  getManagedDeviceToken,
  managedFetch,
  setManagedDeviceToken,
} from './api';

vi.mock('./session', () => ({ getManagedAccount: vi.fn() }));
vi.mock('./api', () => ({
  managedFetch: vi.fn(),
  getManagedApiBase: vi.fn(() => 'https://portal.example/api'),
  getManagedDeviceToken: vi.fn(),
  setManagedDeviceToken: vi.fn(),
}));

const input = { agent_subject: 'did:ad:agent:x' } as RecoverySecretInput;
const saved = {
  owner_email: 'a@example.com',
  agent_subject: 'did:ad:agent:x',
};

beforeEach(() => {
  vi.mocked(getManagedApiBase).mockReturnValue('https://portal.example/api');
  vi.mocked(managedFetch).mockReset();
  vi.mocked(getManagedDeviceToken).mockReset();
  vi.mocked(setManagedDeviceToken).mockReset();
});

it('drops a rejected stale device token and retries without it', async () => {
  vi.mocked(getManagedDeviceToken).mockReturnValue('stale-token');
  vi.mocked(managedFetch)
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(saved)));

  await expect(saveRecoverySecret(input)).resolves.toMatchObject(saved);
  expect(setManagedDeviceToken).toHaveBeenCalledWith(null);
  expect(managedFetch).toHaveBeenCalledTimes(2);
});

it('does not retry a 401 when no device token was sent', async () => {
  vi.mocked(getManagedDeviceToken).mockReturnValue(null);
  vi.mocked(managedFetch).mockResolvedValue(
    new Response(null, { status: 401 }),
  );

  await expect(saveRecoverySecret(input)).rejects.toThrow(/Sign in to/);
  expect(managedFetch).toHaveBeenCalledTimes(1);
});

it('names the status and host when the server gives no reason', async () => {
  vi.mocked(managedFetch).mockResolvedValue(
    new Response(null, { status: 502 }),
  );

  await expect(saveRecoverySecret(input)).rejects.toThrow(
    'Could not save encrypted recovery backup (HTTP 502 from portal.example).',
  );
});
