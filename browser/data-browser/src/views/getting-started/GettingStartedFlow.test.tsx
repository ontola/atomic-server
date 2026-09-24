// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import { Agent } from '@tomic/lib';
import { buildTheme } from '../../styling';

const state = vi.hoisted(() => ({
  portal: 'https://portal.example',
  navigate: vi.fn(),
  setAgent: vi.fn(),
  setDrive: vi.fn(),
  setServer: vi.fn(),
  recovery: vi.fn(),
  account: null as { email: string } | null,
  hasData: true,
  agent: { subject: 'did:ad:agent:test' },
  store: {
    ensurePrivateDrive: vi.fn(async () => undefined),
    getServerUrl: () => 'https://node.example',
    getAgent: () => state.agent,
    privateDriveSubject: async () => 'did:ad:home',
  },
  restoreVault: vi.fn(),
}));
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useStore: () => state.store,
}));
vi.mock('../../helpers/AppSettings', () => ({
  useSettings: () => ({
    baseURL: 'https://node.example',
    setAgent: state.setAgent,
    setDrive: state.setDrive,
    setServer: state.setServer,
  }),
}));
vi.mock('../../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => state.navigate,
}));
vi.mock('../../hooks/useWelcomeLayoutEffect', () => ({
  useWelcomeLayoutEffect: () => undefined,
}));
vi.mock('../../helpers/managed', () => ({
  PRODUCT_NAME: 'Atomic',
  clearManagedAccountBinding: vi.fn(),
  logoutManagedSession: vi.fn(),
}));
vi.mock('../../helpers/managed/cloudSync', () => ({
  getManagedPortalUrl: () => state.portal,
}));
vi.mock('../../helpers/managed/deviceLink', () => ({
  getRememberedProvider: () => null,
  canHoldProviderCookie: () => true,
}));
vi.mock('../../helpers/managed/session', () => ({
  getManagedAccount: async () => state.account,
}));
vi.mock('../../helpers/managedServer', () => ({
  fetchManagedInfo: async () => null,
  accountCreationTarget: () =>
    state.portal ? { kind: 'portal', url: state.portal } : { kind: 'local' },
}));
vi.mock('../../helpers/managed/recovery', () => ({
  getUnlockableRecoverySecret: () => state.recovery(),
  getRecoverySecret: () => state.recovery(),
  readUnlockableCachedBackups: () => [],
}));
vi.mock('../../helpers/managed/vaultAutoBackup', () => ({
  ensureVaultBackup: vi.fn(),
  restoreFromVault: state.restoreVault,
}));
vi.mock('../../helpers/managed/reconcile', () => ({
  connectHostedDrive: async () => true,
}));
vi.mock('../../helpers/agentStorage', () => ({ saveAgentToIDB: vi.fn() }));
vi.mock('../../helpers/deviceLock', () => ({ beat: vi.fn() }));
vi.mock('../../helpers/privateDrive', () => ({
  fetchPrivateDriveSubject: async () => 'did:ad:home',
}));
vi.mock('../../helpers/driveData', () => ({
  deviceHasDriveData: async () => state.hasData,
}));
vi.mock('../../helpers/originNode', () => ({
  isOriginWithoutNode: () => false,
}));
vi.mock('../../helpers/navigation', () => ({
  constructOpenURL: (subject: string) => `/app/show?subject=${subject}`,
}));
vi.mock('../../components/NewIdentitySection', () => ({
  NewIdentitySection: () => <div>Create identity</div>,
}));
vi.mock('./ConnectDeviceStep', () => ({
  ConnectDeviceStep: () => <div>Connect device</div>,
}));
vi.mock('../../components/Vault/LinkProviderPanel', () => ({
  LinkProviderPanel: () => null,
}));
vi.mock('../../components/Logo', () => ({ Logo: () => <div /> }));
vi.mock('../../components/Spinner', () => ({ Spinner: () => <div /> }));
vi.mock('../../components/forms/InputStyles', () => ({
  InputStyled: 'input',
  InputWrapper: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
}));
vi.mock('./chrome', () => ({
  Shell: 'div',
  CardTitle: 'h1',
  CardSubtitle: 'p',
  CardError: 'p',
  CtaButton: ({
    children,
    onClick,
    disabled,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  OnboardingWrap: 'div',
  OnboardingCard: 'div',
  FooterBar: 'div',
  BackLabel: 'span',
}));
import { GettingStartedFlow } from './GettingStartedFlow';

const show = async (query = '') => {
  window.history.replaceState(null, '', `/app/welcome${query}`);
  await act(async () => {
    render(
      <ThemeProvider theme={buildTheme(false, '#336699', false)}>
        <GettingStartedFlow subject='https://node.example' />
      </ThemeProvider>,
    );
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  state.portal = 'https://portal.example';
  state.recovery.mockResolvedValue(null);
  state.account = null;
  state.hasData = true;
  state.restoreVault.mockResolvedValue({
    status: 'no-backup',
    reason: 'no backup',
  });
  vi.spyOn(Agent, 'fromSecret').mockResolvedValue({
    subject: 'did:ad:agent:test',
  } as Agent);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps secret sign-in reachable when a portal is configured', async () => {
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByLabelText('Agent secret')).toBeTruthy();
});

it('keeps a self-hosted welcome usable', async () => {
  state.portal = '';
  await show();
  expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
});

it('opens settings requests directly at unlock', async () => {
  await show('?return_to=agent');
  expect(screen.getByLabelText('Agent secret')).toBeTruthy();
});

it('preserves private-drive unlock', async () => {
  await show('?next=did%3Aad%3Ashared');
  expect(
    screen.getByRole('heading', { name: 'Unlock this drive' }),
  ).toBeTruthy();
  expect(screen.getByLabelText('Agent secret')).toBeTruthy();
});

it('preserves new-account creation from the portal', async () => {
  await show('?from_portal=true&email=new%40example.com');
  expect(screen.getByText('Create identity')).toBeTruthy();
});

it.each([true, false])(
  'returns passkey management to settings after unlock (local data: %s)',
  async hasData => {
    state.hasData = hasData;
    await show('?return_to=agent');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Agent secret'), {
        target: { value: 'test-secret' },
      });
    });
    expect(state.navigate).toHaveBeenCalledWith('/app/agent');
    expect(state.restoreVault).not.toHaveBeenCalled();
  },
);

it('returns a drive link to that drive after secret sign-in', async () => {
  await show('?next=did%3Aad%3Ashared&return_to=agent');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Agent secret'), {
      target: { value: 'test-secret' },
    });
  });
  expect(state.navigate).toHaveBeenCalledWith(
    '/app/show?subject=did:ad:shared',
  );
});

it('keeps an unreadable foreign workspace on the recovery step', async () => {
  state.hasData = false;
  await show('?next=did%3Aad%3Aforeign');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Agent secret'), {
      target: { value: 'test-secret' },
    });
  });
  expect(state.navigate).not.toHaveBeenCalled();
  expect(screen.getByText('Connect device')).toBeTruthy();
});

it('ignores arbitrary return destinations', async () => {
  await show('?step=signin&return_to=https%3A%2F%2Fother.example');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Agent secret'), {
      target: { value: 'test-secret' },
    });
  });
  expect(state.navigate).toHaveBeenCalledWith('/app/show?subject=did:ad:home');
});

it('resumes an invitation instead of settings after unlock', async () => {
  await show('?invite=invitation-token&return_to=agent');
  // Back from restore opens secret sign-in without dropping the invitation.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Agent secret'), {
      target: { value: 'test-secret' },
    });
  });
  expect(state.navigate).toHaveBeenCalledWith(
    expect.stringContaining('/app/invite'),
  );
});

it('lets an invitee with nothing to restore create an account', async () => {
  state.account = { email: 'new@example.com' };
  await show('?invite=invitation-token&email=new%40example.com');
  const assign = vi.fn();
  vi.stubGlobal('location', { href: window.location.href, assign });
  fireEvent.click(
    screen.getByRole('button', { name: 'Create account and accept' }),
  );
  const target = new URL(assign.mock.calls[0][0]);
  expect(target.pathname).toBe('/app/welcome');
  expect(target.searchParams.get('invite')).toBe('invitation-token');
  expect(target.searchParams.get('from_portal')).toBe('true');
  expect(target.searchParams.get('email')).toBe('new@example.com');
});

it('opens its own home without requiring another device', async () => {
  state.hasData = false;
  await show('?step=signin');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Agent secret'), {
      target: { value: 'test-secret' },
    });
  });
  expect(state.store.ensurePrivateDrive).toHaveBeenCalled();
  expect(state.navigate).toHaveBeenCalledWith('/app/show?subject=did:ad:home');
  expect(screen.queryByText('Connect device')).toBeNull();
});
