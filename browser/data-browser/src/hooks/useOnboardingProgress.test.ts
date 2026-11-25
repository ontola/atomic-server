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
vi.mock('./useUserSetting', () => ({}));
vi.mock('./useVisibleDriveChildren', () => ({}));
vi.mock('@chunks/AppPage/useDriveApps', () => ({}));
vi.mock('@helpers/conversations/useConversations', () => ({}));
vi.mock('@helpers/managed/binding', () => ({}));
vi.mock('@helpers/managed/deviceLink', () => ({}));

import type { OnboardingInput } from './useOnboardingProgress';

const {
  deriveAdvancedSteps,
  deriveOnboardingSteps,
  hasInviteForDrives,
  isDefaultDriveName,
} = await import('./useOnboardingProgress');

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

    expect(steps.map(s => s.id)).toEqual(['name', 'create', 'invite', 'save']);
    expect(steps.some(s => s.done)).toBe(false);
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
    const ai = (input: typeof base) =>
      deriveAdvancedSteps(input).find(s => s.id === 'ai');

    expect(ai({ ...base, hasAIChat: true })?.done).toBe(true);
    expect(ai({ ...base, aiAvailable: false })?.needs).toBe('ai-source');
    expect(ai(base)?.needs).toBeUndefined();
  });

  it('leaves the AI steps out when AI is not offered', () => {
    const ids = deriveAdvancedSteps({ ...base, aiEnabled: false }).map(
      s => s.id,
    );

    expect(ids).not.toContain('ai');
    expect(ids).not.toContain('app');
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

describe('deriveAdvancedSteps', () => {
  const adv = (input: Partial<OnboardingInput> = {}) =>
    Object.fromEntries(
      deriveAdvancedSteps({ ...base, ...input }).map(s => [s.id, s.done]),
    );

  it('lists table, form, ai, app, message, none done for a new drive', () => {
    expect(deriveAdvancedSteps(base).map(s => s.id)).toEqual([
      'table',
      'form',
      'ai',
      'app',
      'message',
    ]);
    expect(adv()).toEqual({
      table: false,
      form: false,
      ai: false,
      app: false,
      message: false,
    });
  });

  it("does not count the Welcome template's Tasks table", () => {
    expect(adv({ tableCount: 1, templateTableCount: 1 }).table).toBe(false);
    expect(adv({ tableCount: 2, templateTableCount: 1 }).table).toBe(true);
    expect(adv({ tableCount: 1, templateTableCount: 0 }).table).toBe(true);
  });

  it('counts a form once the drive has one', () => {
    expect(adv({ hasForm: true }).form).toBe(true);
  });

  it('counts the app once the drive has one, and names a missing AI source', () => {
    expect(adv({ hasApp: true }).app).toBe(true);
    const app = (input: OnboardingInput) =>
      deriveAdvancedSteps(input).find(s => s.id === 'app');

    expect(app(base)?.needs).toBeUndefined();
    expect(app({ ...base, aiAvailable: false })?.needs).toBe('ai-source');
  });

  it('counts a conversation for the message step', () => {
    expect(adv({ hasConversation: true }).message).toBe(true);
  });
});
