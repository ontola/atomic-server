// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tomic/react', () => ({
  contacts: { properties: {} },
  core: {},
  urls: { instances: {} },
}));
vi.mock('@components/AI/AISettingsContext', () => ({}));
vi.mock('@components/SideBar/AIPanel', () => ({}));
vi.mock('./usePrivateDrive', () => ({}));
vi.mock('./useSavedDrives', () => ({}));
vi.mock('./useUserSetting', () => ({}));
vi.mock('./useVisibleDriveChildren', () => ({}));
vi.mock('@helpers/managed/binding', () => ({}));
vi.mock('@helpers/managed/deviceLink', () => ({}));

import type { OnboardingInput } from './useOnboardingProgress';

const { deriveOnboardingSteps, hasInviteForDrives, isDefaultDriveName } =
  await import('./useOnboardingProgress');

const base: OnboardingInput = {
  driveName: 'Welcome to Atomic',
  childCount: 4,
  templateChildCount: 4,
  hasAIChat: false,
  aiAvailable: true,
  otherAgentsOnDrives: false,
  accountLinked: false,
};
const done = (input = base) =>
  Object.fromEntries(deriveOnboardingSteps(input).map(s => [s.id, s.done]));

describe('deriveOnboardingSteps', () => {
  it('lists the steps in order, none done for a new person', () => {
    const steps = deriveOnboardingSteps(base);

    expect(steps.map(s => s.id)).toEqual([
      'name',
      'create',
      'ai',
      'invite',
      'save',
    ]);
    expect(steps.some(s => s.done)).toBe(false);
  });

  it('adds Read Start here first, only on a drive that has the document', () => {
    expect(deriveOnboardingSteps(base).some(s => s.id === 'start')).toBe(false);

    const withDoc = deriveOnboardingSteps({
      ...base,
      startHere: { opened: false },
    });

    expect(withDoc[0]).toEqual({ id: 'start', done: false });
    expect(
      deriveOnboardingSteps({ ...base, startHere: { opened: true } })[0].done,
    ).toBe(true);
  });

  it('counts a name as done once it is not a default one', () => {
    for (const name of ['Welcome to Atomic', 'My drive', "Ana's Drive", ''])
      expect(isDefaultDriveName(name)).toBe(true);
    expect(isDefaultDriveName('Acme')).toBe(false);
    expect(done({ ...base, driveName: 'Acme' }).name).toBe(true);
  });

  it('counts Make something once the drive has more than its template gave', () => {
    expect(done().create).toBe(false);
    expect(done({ ...base, childCount: 5 }).create).toBe(true);
    expect(done({ ...base, childCount: 0, templateChildCount: 0 }).create).toBe(
      false,
    );
    expect(done({ ...base, childCount: 1, templateChildCount: 0 }).create).toBe(
      true,
    );
  });

  it('is done for the AI once a chat exists, and names the missing source', () => {
    expect(done({ ...base, hasAIChat: true }).ai).toBe(true);
    expect(
      deriveOnboardingSteps({ ...base, aiAvailable: false })[2].needs,
    ).toBe('ai-source');
    expect(deriveOnboardingSteps(base)[2].needs).toBeUndefined();
  });

  it('is done for Invite once another agent has rights on a drive', () => {
    expect(done().invite).toBe(false);
    expect(done({ ...base, otherAgentsOnDrives: true }).invite).toBe(true);
    expect(done({ ...base, inviteSent: true }).invite).toBe(true);
    expect(done(base).invite).toBe(false);
  });

  it('is done for Save once an account is linked', () => {
    expect(done({ ...base, accountLinked: true }).save).toBe(true);
  });
});

describe('hasInviteForDrives', () => {
  it('matches an invite target against the drives', () => {
    expect(hasInviteForDrives(['did:ad:a'], ['did:ad:a'])).toBe(true);
    expect(hasInviteForDrives(['did:ad:b', undefined], ['did:ad:a'])).toBe(
      false,
    );
    expect(hasInviteForDrives([], ['did:ad:a'])).toBe(false);
  });

  it('counts a copied invite link record, which has no address', () => {
    // Same target the record holds (see pendingInvites.test.ts).
    expect(hasInviteForDrives(['did:ad:a'], ['did:ad:a', 'did:ad:b'])).toBe(
      true,
    );
  });
});
