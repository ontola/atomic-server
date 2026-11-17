// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  order: [] as string[],
  prepare: vi.fn(),
  applyBrought: vi.fn(),
  guest: { subject: 'did:ad:agent:guest', privateDrive: 'did:ad:guesthome' },
  current: undefined as { subject: string } | undefined,
}));

const store = {
  getAgent: () => m.current,
  setAgent: (agent: { subject: string } | undefined) => {
    m.order.push(`setAgent:${agent?.subject}`);
    m.current = agent;
  },
  getServerUrl: () => 'https://app.example',
  registerLocalOnlyDrive: vi.fn(),
  uploadFiles: vi.fn(),
  createDrive: vi.fn(async () => ({ subject: 'did:ad:newdrive' })),
};

vi.mock('@tomic/react', () => {
  class Agent {
    constructor(
      public provider: unknown,
      public subject: string,
    ) {}
    static generateKeyPair = async () => ({
      privateKey: 'priv',
      publicKey: 'pub',
    });
    static buildSecret = () => 'secret';
    static fromSecret = async () => new Agent({}, 'did:ad:agent:new');
    privateDriveSubject = async () => 'did:ad:newhome';
  }

  return {
    Agent,
    JSCryptoProvider: class {
      constructor(public key: string) {}
      getPublicKey = async () => 'pub';
    },
    agentSubject: () => 'did:ad:agent:new',
    dataBrowser: { properties: { icon: 'icon' } },
    useStore: () => store,
  };
});
vi.mock('../helpers/AppSettings', () => ({
  useSettings: () => ({ setAgent: vi.fn(), setDrive: vi.fn() }),
}));
vi.mock('../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => vi.fn(),
}));
vi.mock('../helpers/managed/cloudSync', () => ({
  getManagedPortalUrl: () => undefined,
}));
vi.mock('../helpers/originNode', () => ({ isOriginWithoutNode: () => false }));
vi.mock('../helpers/tauri', () => ({ isRunningInTauri: () => false }));
vi.mock('../helpers/privateDrive', () => ({
  fetchPrivateDriveSubject: vi.fn(),
}));
vi.mock('../helpers/agentStorage', () => ({ saveAgentToIDB: vi.fn() }));
vi.mock('../helpers/startLocalIdentity', () => ({
  saveAgentResource: vi.fn(async () => ({ set: vi.fn(), save: vi.fn() })),
}));
vi.mock('../helpers/driveData', () => ({ reopenRestoredDrive: vi.fn() }));
vi.mock('../helpers/navigation', () => ({
  constructOpenURL: (s: string) => s,
}));
vi.mock('../helpers/managed', () => ({ PRODUCT_NAME: 'Atomic' }));
vi.mock('../helpers/managed/recovery', () => ({
  isPasskeySupported: async () => false,
  PrfUnsupportedError: class extends Error {},
}));
vi.mock('../helpers/bringAlong', () => ({
  prepareIdentitySwitch: m.prepare,
  applyBroughtAlong: m.applyBrought,
}));
vi.mock('./ProfileForm', () => ({
  ProfileForm: ({ onSave }: { onSave: (v: { name: string }) => void }) => (
    <button data-testid='save-profile' onClick={() => onSave({ name: 'Ann' })}>
      save
    </button>
  ),
}));
vi.mock('./Button', () => ({ Button: (p: object) => <button {...p} /> }));
vi.mock('./Row', () => ({
  Column: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Row: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./CodeBlock', () => ({ CodeBlock: () => <div /> }));
vi.mock('./SecretCodeBlock', () => ({ SecretCodeBlock: () => <div /> }));
vi.mock('./forms/InputStyles', () => ({
  InputStyled: 'input',
  InputWrapper: 'div',
}));
vi.mock('./forms/Field', () => ({ default: () => <div /> }));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn() } }));

import { NewIdentitySection } from './NewIdentitySection';

beforeEach(() => {
  vi.clearAllMocks();
  m.order.length = 0;
  m.current = m.guest;
  m.prepare.mockImplementation(async () => {
    m.order.push('prepare');

    return 'brought';
  });
  m.applyBrought.mockResolvedValue(true);
});
afterEach(cleanup);

async function createAccount() {
  const view = render(
    <NewIdentitySection
      autoStart
      onDone={vi.fn()}
      stepIndicatorPortal={null}
      defaultProfileName='ann'
    />,
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(view.getByTestId('save-profile'));
  });
  await act(async () => {});
}

it('hands the guest identity its drives over before the new agent replaces it', async () => {
  await createAccount();

  expect(m.prepare).toHaveBeenCalledTimes(1);
  expect(m.prepare.mock.calls[0][1]).toBe('did:ad:agent:new');
  // The guest must still be the active agent while it grants the new one.
  expect(m.order.indexOf('prepare')).toBeLessThan(
    m.order.indexOf('setAgent:did:ad:agent:new'),
  );
});

it('lists the brought drives in the new home once it exists', async () => {
  await createAccount();

  expect(m.applyBrought).toHaveBeenCalledWith(
    store,
    'did:ad:agent:new',
    'did:ad:newdrive',
  );
});

it('does not apply anything when nothing was brought', async () => {
  m.prepare.mockResolvedValue('left');
  await createAccount();

  expect(m.applyBrought).not.toHaveBeenCalled();
});

it('still creates the account when handing the guest work over fails', async () => {
  m.prepare.mockRejectedValue(new Error('grant refused'));
  await createAccount();

  expect(m.order).toContain('setAgent:did:ad:agent:new');
  expect(store.createDrive).toHaveBeenCalled();
  expect(m.applyBrought).not.toHaveBeenCalled();
});
