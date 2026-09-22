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
  disposable: vi.fn(),
  server: vi.fn(),
  sync: vi.fn(),
  binding: vi.fn(),
}));
const store = {
  getAgent: () => state.agent,
  getServerUrl: () => 'https://node.example',
  getDrive: () => 'did:ad:drive',
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
  localAgentIsDisposable: state.disposable,
  evaluateServerReconciliation: state.server,
  syncDeviceDirectory: state.sync,
  writeManagedAccountBinding: state.binding,
  clearManagedAccountBinding: vi.fn(),
  logoutManagedSession: vi.fn(),
  PRODUCT_NAME: 'Atomic',
}));
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
  state.evaluate.mockResolvedValue({ ok: true, managedAccount: null });
  state.disposable.mockResolvedValue(true);
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
  expect(state.disposable).not.toHaveBeenCalled();
});

it('ignores a pending workspace check after entering the unlock flow', async () => {
  const disposable = Promise.withResolvers<boolean>();
  state.evaluate.mockResolvedValue(mismatch);
  state.disposable.mockReturnValueOnce(disposable.promise);
  const mounted = render(view());
  await act(async () => {});
  state.pathname = '/app/welcome';
  await act(async () => mounted.rerender(view()));
  await act(async () => disposable.resolve(true));
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
