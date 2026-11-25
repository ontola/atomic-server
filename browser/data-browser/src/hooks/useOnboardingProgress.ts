// @wc-ignore-file
import { useEffect } from 'react';
import {
  contacts,
  core,
  dataBrowser,
  forms,
  StoreEvents,
  urls,
  useStore,
  useCollection,
  useCollectionPage,
  useCurrentAgent,
  useResources,
} from '@tomic/react';
import {
  WELCOME_PART_COUNT,
  welcomeDriveTitle,
} from '../chunks/Templates/welcome';
import { useVisibleDriveChildren } from './useVisibleDriveChildren';
import { canonicalizeScheme } from '@tomic/lib';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useDriveChats } from '@components/SideBar/AIPanel';
import { useIsLinkedToAccount } from './useIsLinkedToAccount';
import { pendingInviteQuery } from '../helpers/pendingInvites';
import { usePrivateDrive } from './usePrivateDrive';
import { usePrivateDriveSync } from './usePrivateDriveSync';
import { useDriveApps } from '@chunks/AppPage/useDriveApps';
import { useConversations } from '@helpers/conversations/useConversations';
import { userSettingProps, useUserSetting } from './useUserSetting';

export type OnboardingStepId =
  | 'name'
  | 'create'
  | 'ai'
  | 'invite'
  | 'save'
  | 'table'
  | 'form'
  | 'app'
  | 'message';

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
  return (
    !name ||
    name === welcomeDriveTitle() ||
    /^(Welcome to Atomic|My drive|.+'s Drive)$/.test(name)
  );
}

export interface OnboardingInput {
  driveName?: string;
  /** Visible children of the drive the panel is for, and how many its template gave. */
  childCount: number;
  templateChildCount: number;
  hasAIChat: boolean;
  /** AI is offered at all; a guest in a hosted build has none until they register. */
  aiEnabled?: boolean;
  aiAvailable: boolean;
  /** Agents with rights on the panel's drive, other than the signed-in one. */
  otherAgentsOnDrives: boolean;
  /** An invite was sent for that drive (not necessarily accepted yet). */
  inviteSent?: boolean;
  accountLinked: boolean;
  /** Tables among the drive's visible children, and how many its template made. */
  tableCount?: number;
  templateTableCount?: number;
  hasForm?: boolean;
  /** The drive has at least one app. */
  hasApp?: boolean;
  /** The agent is in at least one conversation. */
  hasConversation?: boolean;
}

/** The steps in order, each with a derived `done` and, if blocked, why. */
export function deriveOnboardingSteps(
  input: OnboardingInput,
): OnboardingStep[] {
  return [
    { id: 'name', done: !isDefaultDriveName(input.driveName) },
    { id: 'create', done: input.childCount > input.templateChildCount },
    { id: 'invite', done: input.otherAgentsOnDrives || !!input.inviteSent },
    { id: 'save', done: input.accountLinked },
  ];
}

/** The second round, shown once every basic step is done. */
export function deriveAdvancedSteps(input: OnboardingInput): OnboardingStep[] {
  const aiEnabled = input.aiEnabled ?? true;
  const steps: OnboardingStep[] = [
    {
      id: 'table',
      done: (input.tableCount ?? 0) > (input.templateTableCount ?? 0),
    },
    { id: 'form', done: !!input.hasForm },
    {
      id: 'ai',
      done: input.hasAIChat,
      needs: input.aiAvailable ? undefined : 'ai-source',
    },
    {
      id: 'app',
      done: !!input.hasApp,
      needs: input.aiAvailable ? undefined : 'ai-source',
    },
    { id: 'message', done: !!input.hasConversation },
  ];

  return steps.filter(
    step => aiEnabled || (step.id !== 'ai' && step.id !== 'app'),
  );
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
  const isWelcome = same(drive, welcomeDrive);
  const templateChildCount = isWelcome ? WELCOME_PART_COUNT : 0;
  // Already loaded by the children query above, so this adds no requests.
  const childResources = useResources(children);
  const childClasses = [...childResources.values()].map(r => r.getClasses());
  // Only the panel's own drive: fetching every saved drive to look for other
  // members hits legacy drives on dead servers on every render.
  const shared = same(drive, privateDrive) ? [] : [drive];
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
  // The query the Share dialog's pending list uses. A query on the property
  // alone (any target) returns nothing in the browser, so this asks for the
  // panel's own drive, which is the drive the step is about.
  const { collection, invalidateCollection } = useCollection(
    pendingInviteQuery(privateDrive, drive),
    { pageSize: 100 },
  );
  usePrivateDriveSync(privateDrive, invalidateCollection);
  // A filter on the property alone does not recognise a brand-new Contact as a
  // member, so an invite recorded in this session (the Share dialog) would
  // only show after a reload. Refresh when one is made.
  const store = useStore();
  useEffect(
    () =>
      store.on(StoreEvents.ResourceManuallyCreated, r => {
        const to = r.get(contacts.properties.invitedTo);

        if (typeof to === 'string' && same(to, drive))
          void invalidateCollection();
      }),
    [store, drive, invalidateCollection],
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
  const conversations = useConversations();
  const basics: OnboardingInput = {
    driveName,
    childCount: children.length,
    templateChildCount,
    hasAIChat: chats.length > 0,
    aiEnabled: enableAI,
    aiAvailable: enableAI && availableProviders.length > 0,
    otherAgentsOnDrives: others,
    inviteSent,
    accountLinked,
  };
  // Only the advanced round asks what apps the drive has, so the panel costs
  // no extra query for as long as the basics are what it shows.
  const advancedShown = deriveOnboardingSteps(basics).every(s => s.done);
  const { apps } = useDriveApps(advancedShown ? drive : undefined);
  const input: OnboardingInput = {
    ...basics,
    // The Welcome template's Tasks table is not the person's own.
    tableCount: childClasses.filter(c => c.includes(dataBrowser.classes.table))
      .length,
    templateTableCount: isWelcome ? 1 : 0,
    hasForm: childClasses.some(c => c.includes(forms.classes.form)),
    hasApp: apps.length > 0,
    hasConversation: conversations.length > 0,
  };
  const steps = deriveOnboardingSteps(input);
  const advancedSteps = deriveAdvancedSteps(input);
  const count = (list: OnboardingStep[]) => list.filter(s => s.done).length;

  return {
    steps,
    doneCount: count(steps),
    advancedSteps,
    advancedDoneCount: count(advancedSteps),
  };
}
