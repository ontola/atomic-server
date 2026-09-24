import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/react';
import { prepareTemplateDrive } from './prepareTemplateDrive';
import { fetchManagedInfo } from '../../helpers/managedServer';
import { getManagedEnrollments } from '../../helpers/managed/enrollmentApi';
import { getManagedAccount } from '../../helpers/managed/session';

vi.mock('../../helpers/managedServer', () => ({
  fetchManagedInfo: vi.fn(),
}));
vi.mock('../../helpers/managed/enrollmentApi', () => ({
  getManagedEnrollments: vi.fn(),
}));
vi.mock('../../helpers/managed/session', () => ({
  getManagedAccount: vi.fn(),
}));

const home = 'did:ad:home';
const node = 'https://node1.example';

function fixture(local = false, guest = false) {
  const store = {
    getServerUrl: () => node,
    getAgent: () => ({
      subject: 'did:ad:agent:owner',
      privateDriveSubject: async () => home,
    }),
    // Real accounts get a personal drive at signup; demo guests never do.
    getResource: async () => ({ get: () => (guest ? undefined : home) }),
    isLocalOnlyDrive: () => local,
    makeDriveLocal: vi.fn(async () => {}),
    registerLocalOnlyDrive: vi.fn(),
  };

  return store as unknown as Store & typeof store;
}

beforeEach(() => {
  vi.mocked(fetchManagedInfo).mockReset();
  vi.mocked(fetchManagedInfo).mockResolvedValue({
    managed: true,
    portalUrl: 'https://portal.example',
  });
  vi.mocked(getManagedEnrollments).mockReset();
  vi.mocked(getManagedEnrollments).mockResolvedValue([]);
  vi.mocked(getManagedAccount).mockReset();
  vi.mocked(getManagedAccount).mockResolvedValue({ email: 'a@example.com' });
});

describe('template drive preparation', () => {
  it('verifies the unenrolled home before creating a browser-only drive', async () => {
    const store = fixture();
    await prepareTemplateDrive(store);
    expect(getManagedEnrollments).toHaveBeenCalledWith(true);
    expect(store.makeDriveLocal).toHaveBeenCalledExactlyOnceWith(home);
  });

  it('keeps hosting when the home is enrolled on this node', async () => {
    const store = fixture();
    vi.mocked(getManagedEnrollments).mockResolvedValue([
      {
        drive_subject: home,
        agent_subject: 'did:ad:agent:owner',
        status: 'Active',
        http_origin: node,
      },
    ]);
    await prepareTemplateDrive(store);
    expect(store.makeDriveLocal).not.toHaveBeenCalled();
  });

  it('does not mistake another node enrollment for local hosting', async () => {
    const store = fixture();
    vi.mocked(getManagedEnrollments).mockResolvedValue([
      {
        drive_subject: home,
        agent_subject: 'did:ad:agent:owner',
        status: 'Active',
        http_origin: 'https://node2.example',
      },
    ]);
    await expect(prepareTemplateDrive(store)).rejects.toThrow(
      'hosted on another device',
    );
    expect(store.makeDriveLocal).not.toHaveBeenCalled();
  });

  it('does not alter self-hosted or already local drives', async () => {
    const store = fixture(true);
    await prepareTemplateDrive(store);
    expect(getManagedEnrollments).not.toHaveBeenCalled();
    vi.mocked(fetchManagedInfo).mockResolvedValue({
      managed: false,
      portalUrl: null,
    });
    await prepareTemplateDrive(fixture());
    expect(getManagedEnrollments).not.toHaveBeenCalled();
  });

  it('keeps the remote route when verification fails', async () => {
    const store = fixture();
    store.makeDriveLocal.mockRejectedValue(new Error('Missing attachment'));
    await expect(prepareTemplateDrive(store)).rejects.toThrow(
      'Missing attachment',
    );
  });

  it('lets a demo guest create a browser-only drive without an account', async () => {
    const store = fixture(false, true);
    vi.mocked(getManagedAccount).mockResolvedValue(null);
    await prepareTemplateDrive(store);
    expect(getManagedEnrollments).not.toHaveBeenCalled();
    // Nothing to verify on the server: a guest's home was never there.
    expect(store.makeDriveLocal).not.toHaveBeenCalled();
    expect(store.registerLocalOnlyDrive).toHaveBeenCalledExactlyOnceWith(home);
  });

  it('still asks a signed-out account to sign in', async () => {
    const store = fixture();
    vi.mocked(getManagedAccount).mockResolvedValue(null);
    vi.mocked(getManagedEnrollments).mockRejectedValue(
      new Error('Sign in to check Cloud Server hosting.'),
    );
    await expect(prepareTemplateDrive(store)).rejects.toThrow('Sign in');
    expect(store.makeDriveLocal).not.toHaveBeenCalled();
  });
});
