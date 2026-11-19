// @wc-ignore-file
// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  binding: vi.fn(),
  deviceLinked: vi.fn(),
  hasAccount: vi.fn(),
}));

vi.mock('@tomic/react', () => ({
  core: { properties: { read: 'read', write: 'write' } },
  urls: { instances: {} },
  useCurrentAgent: () => [{ subject: 'did:ad:agent:me' }],
  useResources: () => new Map(),
}));
vi.mock('@components/AI/AISettingsContext', () => ({
  useAISettings: () => ({ enableAI: false, availableProviders: [] }),
}));
vi.mock('@components/SideBar/AIPanel', () => ({ useDriveChats: () => [] }));
vi.mock('./usePrivateDrive', () => ({
  usePrivateDrive: () => ({ privateDrive: 'atomic:home' }),
}));
vi.mock('./useSavedDrives', () => ({ useSavedDrives: () => [[]] }));
vi.mock('./useLocalStorage', () => ({
  useLocalStorage: (_key: string, initial: unknown) => [initial, () => {}],
}));
vi.mock('./useHasManagedAccount', () => ({
  useHasManagedAccount: mocks.hasAccount,
}));
vi.mock('@helpers/managed/binding', () => ({
  readManagedAccountBinding: mocks.binding,
}));
vi.mock('@helpers/managed/deviceLink', () => ({
  isDeviceLinked: mocks.deviceLinked,
}));

const { deriveOnboardingSteps, isDefaultDriveName, projectDrives } =
  await import('./useOnboardingProgress');
const { useOnboardingProgress } = await import('./useOnboardingProgress');

const base = {
  driveName: 'Welcome to Atomic',
  savedDrives: ['atomic:home', 'atomic:welcome'],
  privateDrive: 'atomic:home',
  welcomeDrive: 'atomic:welcome',
  hasAIChat: false,
  aiAvailable: true,
  otherAgentsOnProjects: false,
  invited: false,
  accountLinked: false,
};
const done = (input = base) =>
  Object.fromEntries(deriveOnboardingSteps(input).map(s => [s.id, s.done]));

describe('deriveOnboardingSteps', () => {
  it('lists the steps in order, none done for a new person', () => {
    const steps = deriveOnboardingSteps(base);

    expect(steps.map(s => s.id)).toEqual([
      'name',
      'project',
      'ai',
      'invite',
      'save',
    ]);
    expect(steps.some(s => s.done)).toBe(false);
  });

  it('counts a name as done once it is not a default one', () => {
    for (const name of ['Welcome to Atomic', 'My drive', "Ana's Drive", ''])
      expect(isDefaultDriveName(name)).toBe(true);
    expect(isDefaultDriveName('Acme')).toBe(false);
    expect(done({ ...base, driveName: 'Acme' }).name).toBe(true);
  });

  it('counts a project as a drive besides home and Welcome, even renamed', () => {
    expect(done().project).toBe(false);
    const withProject = {
      ...base,
      savedDrives: [...base.savedDrives, 'did:ad:p'],
    };

    expect(done(withProject).project).toBe(true);
    expect(projectDrives(withProject)).toEqual(['did:ad:p']);
  });

  it('is done for the AI once a chat exists, and names the missing source', () => {
    expect(done({ ...base, hasAIChat: true }).ai).toBe(true);
    expect(
      deriveOnboardingSteps({ ...base, aiAvailable: false })[2].needs,
    ).toBe('ai-source');
    expect(deriveOnboardingSteps(base)[2].needs).toBeUndefined();
  });

  it('blocks Invite until there is a project, then accepts a link or another agent', () => {
    const blocked = deriveOnboardingSteps({ ...base, invited: true })[3];

    expect(blocked.needs).toBe('project');

    const withProject = {
      ...base,
      savedDrives: [...base.savedDrives, 'did:ad:p'],
    };

    expect(deriveOnboardingSteps(withProject)[3]).toMatchObject({
      done: false,
      needs: undefined,
    });
    expect(done({ ...withProject, invited: true }).invite).toBe(true);
    expect(done({ ...withProject, otherAgentsOnProjects: true }).invite).toBe(
      true,
    );
  });

  it('is done for Save once an account is linked', () => {
    expect(done({ ...base, accountLinked: true }).save).toBe(true);
  });
});

describe('useOnboardingProgress Save step', () => {
  const save = () =>
    renderHook(() => useOnboardingProgress()).result.current.steps.find(
      s => s.id === 'save',
    );

  beforeEach(() => {
    mocks.binding.mockReturnValue(null);
    mocks.deviceLinked.mockReturnValue(false);
    mocks.hasAccount.mockReturnValue(undefined);
  });

  it('is not done with no binding, no device token and no account', () => {
    expect(save()?.done).toBe(false);
    mocks.hasAccount.mockReturnValue(false);
    expect(save()?.done).toBe(false);
  });

  it('is done for a signed-in account without a binding or device token', () => {
    mocks.hasAccount.mockReturnValue(true);
    expect(save()?.done).toBe(true);
  });

  it('is still done by a binding or a linked device alone', () => {
    mocks.binding.mockReturnValue({
      owner_email: 'a',
      expected_agent_subject: 'b',
    });
    expect(save()?.done).toBe(true);
    mocks.binding.mockReturnValue(null);
    mocks.deviceLinked.mockReturnValue(true);
    expect(save()?.done).toBe(true);
  });
});
