// @wc-ignore-file
import { useSyncExternalStore } from 'react';
import {
  contacts,
  core,
  urls,
  useCollection,
  useCollectionPage,
  useCurrentAgent,
  useResources,
} from '@tomic/react';
import {
  TEMPLATE_CATALOG,
  WELCOME_DOC_NAME,
} from '../chunks/Templates/catalog';
import {
  getRecentResources,
  subscribeRecentResources,
} from '../helpers/recentResources';
import { useVisibleDriveChildren } from './useVisibleDriveChildren';
import { canonicalizeScheme } from '@tomic/lib';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useDriveChats } from '@components/SideBar/AIPanel';
import { useIsLinkedToAccount } from './useIsLinkedToAccount';
import { usePrivateDrive } from './usePrivateDrive';
import { useSavedDrives } from './useSavedDrives';
import { userSettingProps, useUserSetting } from './useUserSetting';

export type OnboardingStepId =
  | 'start'
  | 'name'
  | 'create'
  | 'ai'
  | 'invite'
  | 'save';

/** What a step is waiting for before its button can do anything. */
export type OnboardingNeed = 'ai-source';

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
  needs?: OnboardingNeed;
}

/**
 * What the card shows is derived from what exists. The one fact that leaves no
 * trace to derive from, which drive is the Welcome drive, is a user setting on
 * the personal drive (`useUserSetting`); these keys are its offline fallback.
 */
export const onboardingKeys = {
  /** The drive `startWelcomeDrive` made; it stays the Welcome drive when renamed. */
  welcomeDrive: (agent?: string) => `atomic.gettingStarted.welcome:${agent}`,
};

const same = (a: string, b?: string) =>
  !!b && canonicalizeScheme(a) === canonicalizeScheme(b);

/** A drive keeps its first name until someone gives it one of their own. */
export function isDefaultDriveName(name: string | undefined): boolean {
  return !name || /^(Welcome to Atomic|My drive|.+'s Drive)$/.test(name);
}

export interface OnboardingInput {
  /** Set on the Welcome drive when it still has its Start here document. */
  startHere?: { opened: boolean };
  driveName?: string;
  /** Visible children of the drive the panel is for, and how many its template gave. */
  childCount: number;
  templateChildCount: number;
  hasAIChat: boolean;
  aiAvailable: boolean;
  /** Agents with rights on any of the user's non-personal drives, other than the signed-in one. */
  otherAgentsOnDrives: boolean;
  /** An email invite was sent for one of those drives (not necessarily accepted yet). */
  inviteSent?: boolean;
  accountLinked: boolean;
}

/** The steps in order, each with a derived `done` and, if blocked, why. */
export function deriveOnboardingSteps(
  input: OnboardingInput,
): OnboardingStep[] {
  return [
    ...(input.startHere
      ? [{ id: 'start' as const, done: input.startHere.opened }]
      : []),
    { id: 'name', done: !isDefaultDriveName(input.driveName) },
    { id: 'create', done: input.childCount > input.templateChildCount },
    {
      id: 'ai',
      done: input.hasAIChat,
      needs: input.aiAvailable ? undefined : 'ai-source',
    },
    { id: 'invite', done: input.otherAgentsOnDrives || !!input.inviteSent },
    { id: 'save', done: input.accountLinked },
  ];
}

/**
 * Whether any email-invite Contact points at one of `drives`. Such a Contact
 * lives in the inviter's own private drive (see `pendingInvites.ts`), so it is
 * by construction one this agent created.
 */
export function hasInviteForDrives(
  invitedTargets: Array<string | undefined>,
  drives: string[],
): boolean {
  return invitedTargets.some(
    t => typeof t === 'string' && drives.some(d => same(d, t)),
  );
}

export function useOnboardingProgress(drive: string, driveName?: string) {
  const [agent] = useCurrentAgent();
  const { privateDrive } = usePrivateDrive();
  const [savedDrives] = useSavedDrives();
  const { enableAI, availableProviders } = useAISettings();
  const chats = useDriveChats(privateDrive);
  const [welcomeDrive] = useUserSetting<string | undefined>(
    userSettingProps.welcomeDrive,
    onboardingKeys.welcomeDrive(agent?.subject),
    undefined,
  );
  const accountLinked = useIsLinkedToAccount();
  const { subjects: children } = useVisibleDriveChildren(drive);
  // The Welcome template fills its drive; anything past that is the person's.
  const templateChildCount = same(drive, welcomeDrive)
    ? TEMPLATE_CATALOG.find(t => t.id === 'welcome')!.parts.length
    : 0;
  // The panel's own drive counts even when it is not on the saved list yet.
  const shared = [...new Set([...savedDrives, drive])].filter(
    d => !same(d, privateDrive),
  );
  const resources = useResources(shared);
  const others = [...resources.values()].some(r =>
    [r.get(core.properties.read), r.get(core.properties.write)]
      .flat()
      .some(
        a =>
          typeof a === 'string' &&
          a !== agent?.subject &&
          a !== urls.instances.publicAgent,
      ),
  );
  const { collection } = useCollection(
    {
      property: contacts.properties.invitedTo,
      drive: privateDrive,
    },
    { pageSize: 100 },
  );
  const inviteMembers = useCollectionPage(collection, 0);
  const inviteContacts = useResources(privateDrive ? inviteMembers : []);
  const inviteSent = hasInviteForDrives(
    [...inviteContacts.values()].map(r => {
      const t = r.get(contacts.properties.invitedTo);

      return typeof t === 'string' ? t : undefined;
    }),
    shared,
  );
  const childResources = useResources(
    same(drive, welcomeDrive) ? children : [],
  );
  // Found by the name the template wrote, which is never translated; a
  // renamed or deleted document drops the step.
  const startHereSubject = [...childResources.values()].find(
    r => r.get(core.properties.name) === WELCOME_DOC_NAME,
  )?.subject;
  const startHereOpened = useSyncExternalStore(
    subscribeRecentResources,
    () =>
      !!startHereSubject &&
      getRecentResources(agent?.subject, drive).includes(startHereSubject),
  );
  const input: OnboardingInput = {
    startHere: startHereSubject ? { opened: startHereOpened } : undefined,
    driveName,
    childCount: children.length,
    templateChildCount,
    hasAIChat: chats.length > 0,
    aiAvailable: enableAI && availableProviders.length > 0,
    otherAgentsOnDrives: others,
    inviteSent,
    accountLinked,
  };
  const steps = deriveOnboardingSteps(input);

  return {
    steps,
    /** The Start here document, for the step to point at. */
    startHere: startHereSubject,
    doneCount: steps.filter(s => s.done).length,
  };
}
