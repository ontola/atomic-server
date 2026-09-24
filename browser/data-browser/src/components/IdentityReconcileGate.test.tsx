// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IdentityReconcileResult } from '../helpers/managed/reconcile';

const state = vi.hoisted(() => ({
  agent: { subject: 'did:ad:agent:old' },
  pathname: '/app/show',
  navigate: vi.fn(),
  setServer: vi.fn(),
  evaluate: vi.fn(),
  workspace: vi.fn(),
  handOver: vi.fn(),
  applyPending: vi.fn(),
  capture: vi.fn(),
  stage: vi.fn(),
  importCarried: vi.fn(),
  server: vi.fn(),
  sync: vi.fn(),
  binding: vi.fn(),
  archive: vi.fn(),
  guest: true,
}));
const store = {
  getAgent: () => ({ ...state.agent, privateDrive: 'did:ad:home' }),
  getServerUrl: () => 'https://node.example',
  getDrive: () => 'did:ad:drive',
  // A demo guest's own subject is registered as local-only.
  isLocalOnlyDrive: (subject: string) =>
    state.guest && subject === 'did:ad:agent:old',
};
vi.mock('@tomic/react', () => ({ useStore: () => store }));
vi.mock('../helpers/AppSettings', () => ({
  useSettings: () => ({ agent: state.agent, setServer: state.setServer }),
}));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: state.pathname }),
  useNavigate: () => state.navigate,
}));
vi.mock('../helpers/managed', () => ({
  evaluateIdentityReconciliation: state.evaluate,
  localAgentWorkspace: state.workspace,
  evaluateServerReconciliation: state.server,
  syncDeviceDirectory: state.sync,
  writeManagedAccountBinding: state.binding,
  clearManagedAccountBinding: vi.fn(),
  logoutManagedSession: vi.fn(),
  PRODUCT_NAME: 'Atomic',
}));
vi.mock('../helpers/managed/driveHandover', () => ({
  handOverDrives: state.handOver,
  applyPendingDriveHandover: state.applyPending,
}));
vi.mock('../helpers/managed/driveCarryOver', () => ({
  stageDriveCarryOver: state.stage,
  importDriveCarryOver: state.importCarried,
}));
vi.mock('../helpers/clientDbMode', () => ({ isClientDbEnabled: () => true }));
vi.mock('../helpers/agentStorage', () => ({
  archiveStoredAgent: state.archive,
}));
vi.mock('../chunks/Templates/demoSession', () => ({
  readInteractiveDemo: () => ({ drive: 'did:ad:demo', welcomeDoc: 'x' }),
  readTemplateDemo: () => undefined,
}));
vi.mock('@sentry/react', () => ({ captureException: state.capture }));
vi.mock('./Button', () => ({ Button: 'button' }));
vi.mock('./Row', () => ({ Column: 'div' }));
vi.mock('../views/getting-started/chrome', () => ({
  CardSubtitle: 'p',
  CardTitle: 'h1',
  OnboardingCard: 'div',
  OnboardingWrap: 'div',
  Shell: 'div',
}));
import { IdentityReconcileGate } from './IdentityReconcileGate';

const mismatch: IdentityReconcileResult = {
  ok: false,
  issue: {
    reason: 'recovery_agent',
    localAgentSubject: 'did:ad:agent:old',
    expectedAgentSubject: 'did:ad:agent:account',
    managedAccountEmail: 'a@example.com',
  },
};
const view = () => (
  <IdentityReconcileGate>
    <div>Workspace</div>
  </IdentityReconcileGate>
);
beforeEach(() => {
  vi.clearAllMocks();
  state.agent = { subject: 'did:ad:agent:old' };
  state.pathname = '/app/show';
  state.guest = true;
  state.archive.mockResolvedValue(undefined);
  state.evaluate.mockResolvedValue({ ok: true, managedAccount: null });
  state.workspace.mockResolvedValue('none');
  state.handOver.mockResolvedValue({
    agent: 'did:ad:agent:account',
    drives: [],
  });
  state.applyPending.mockResolvedValue(false);
  state.server.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

it('ignores a mismatch that finishes after a newer secret sign-in', async () => {
  const old = Promise.withResolvers<IdentityReconcileResult>();
  state.evaluate.mockReturnValueOnce(old.promise);
  const mounted = render(view());
  await act(async () => {
    state.agent = { subject: 'did:ad:agent:new' };
    mounted.rerender(view());
  });
  await act(async () => old.resolve(mismatch));
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.workspace).not.toHaveBeenCalled();
});

it('ignores a pending workspace check after entering the unlock flow', async () => {
  const workspace = Promise.withResolvers<'none'>();
  state.evaluate.mockResolvedValue(mismatch);
  state.workspace.mockReturnValueOnce(workspace.promise);
  const mounted = render(view());
  await act(async () => {});
  state.pathname = '/app/welcome';
  await act(async () => mounted.rerender(view()));
  await act(async () => workspace.resolve('none'));
  expect(state.navigate).not.toHaveBeenCalled();
});

it('does not repoint the new identity at a stale server after sign-in', async () => {
  const server = Promise.withResolvers<{ ok: false; expectedOrigin: string }>();
  state.server.mockReturnValueOnce(server.promise);
  const mounted = render(view());
  await act(async () => {});
  state.agent = { subject: 'did:ad:agent:new' };
  await act(async () => mounted.rerender(view()));
  await act(async () =>
    server.resolve({ ok: false, expectedOrigin: 'https://old.example' }),
  );
  expect(state.setServer).not.toHaveBeenCalled();
});

it('still routes a current disposable mismatch to unlock', async () => {
  state.evaluate.mockResolvedValue(mismatch);
  render(view());
  await act(async () => {});
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: '/app/welcome' }),
  );
});

it.each(['some', 'unknown'])(
  'hands a %s workspace to the account, then switches without asking',
  async workspace => {
    state.evaluate.mockResolvedValue(mismatch);
    state.workspace.mockResolvedValue(workspace);
    const { queryByTestId } = render(view());
    await act(async () => {});
    expect(state.handOver).toHaveBeenCalledWith(
      store,
      expect.objectContaining({
        from: 'did:ad:agent:old',
        to: 'did:ad:agent:account',
        personalDrive: 'did:ad:home',
        skip: ['did:ad:demo', undefined],
        carryOver: expect.any(Function),
      }),
    );
    // Local-only drives are copied out of the old identity's database.
    await state.handOver.mock.calls[0][1].carryOver(['did:ad:kept']);
    expect(state.stage).toHaveBeenCalledWith(store, {
      from: 'did:ad:agent:old',
      to: 'did:ad:agent:account',
      drives: ['did:ad:kept'],
    });
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/app/welcome',
        search: expect.objectContaining({ step: 'signin' }),
      }),
    );
    expect(queryByTestId('identity-conflict')).toBeNull();
  },
);

it('keeps, but shares nothing from, an identity that is not a demo guest', async () => {
  state.guest = false;
  state.evaluate.mockResolvedValue(mismatch);
  state.workspace.mockResolvedValue('some');
  const { queryByTestId } = render(view());
  await act(async () => {});
  expect(state.handOver).not.toHaveBeenCalled();
  expect(state.archive).toHaveBeenCalledWith('did:ad:agent:old');
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: '/app/welcome' }),
  );
  expect(queryByTestId('identity-conflict')).toBeNull();
});

it('does not hand over a workspace-less agent', async () => {
  state.evaluate.mockResolvedValue(mismatch);
  render(view());
  await act(async () => {});
  expect(state.handOver).not.toHaveBeenCalled();
  expect(state.navigate).toHaveBeenCalled();
});

it('asks, and reports, only when the handover fails', async () => {
  state.evaluate.mockResolvedValue(mismatch);
  state.workspace.mockResolvedValue('some');
  state.handOver.mockRejectedValue(new Error('save failed'));
  const { findByTestId } = render(view());
  expect(await findByTestId('identity-conflict')).toBeTruthy();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.capture).toHaveBeenCalledOnce();
});

it('imports carried-over drives and lists handed-over ones once the account identity is active', async () => {
  state.agent = { subject: 'did:ad:agent:account' };
  render(view());
  await act(async () => {});
  expect(state.applyPending).toHaveBeenCalledWith(
    store,
    'did:ad:agent:account',
    expect.any(Function),
  );
  // Imports what was carried over into the account identity's database.
  await state.applyPending.mock.calls[0][2]('did:ad:agent:account');
  expect(state.importCarried).toHaveBeenCalledWith(
    store,
    'did:ad:agent:account',
  );
});
