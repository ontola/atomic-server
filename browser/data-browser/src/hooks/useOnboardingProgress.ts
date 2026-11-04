// @wc-ignore-file
import { core, urls, useCurrentAgent, useResources } from '@tomic/react';
import { canonicalizeScheme } from '@tomic/lib';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useDriveChats } from '@components/SideBar/AIPanel';
import { useIsLinkedToAccount } from './useIsLinkedToAccount';
import { usePrivateDrive } from './usePrivateDrive';
import { useSavedDrives } from './useSavedDrives';
import { userSettingProps, useUserSetting } from './useUserSetting';

export type OnboardingStepId = 'name' | 'project' | 'ai' | 'invite' | 'save';

/** What a step is waiting for before its button can do anything. */
export type OnboardingNeed = 'project' | 'ai-source';

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
  driveName?: string;
  /** Drives on the private drive's list, in the order they were added. */
  savedDrives: string[];
  privateDrive?: string;
  welcomeDrive?: string;
  hasAIChat: boolean;
  aiAvailable: boolean;
  /** Agents with rights on each project drive, other than the signed-in one. */
  otherAgentsOnProjects: boolean;
  accountLinked: boolean;
}

/** The project drive: the most recently added one that is neither home nor Welcome. */
export function projectDrives(input: OnboardingInput): string[] {
  return input.savedDrives.filter(
    d => !same(d, input.privateDrive) && !same(d, input.welcomeDrive),
  );
}

/** The steps in order, each with a derived `done` and, if blocked, why. */
export function deriveOnboardingSteps(
  input: OnboardingInput,
): OnboardingStep[] {
  const hasProject = projectDrives(input).length > 0;

  return [
    { id: 'name', done: !isDefaultDriveName(input.driveName) },
    { id: 'project', done: hasProject },
    {
      id: 'ai',
      done: input.hasAIChat,
      needs: input.aiAvailable ? undefined : 'ai-source',
    },
    {
      id: 'invite',
      done: input.otherAgentsOnProjects,
      needs: hasProject ? undefined : 'project',
    },
    { id: 'save', done: input.accountLinked },
  ];
}

export function useOnboardingProgress(driveName?: string) {
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
  const base = { savedDrives, privateDrive, welcomeDrive } as OnboardingInput;
  const projects = projectDrives(base);
  const resources = useResources(projects);
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
  const input: OnboardingInput = {
    ...base,
    driveName,
    hasAIChat: chats.length > 0,
    aiAvailable: enableAI && availableProviders.length > 0,
    otherAgentsOnProjects: others,
    accountLinked,
  };
  const steps = deriveOnboardingSteps(input);

  return {
    steps,
    /** Where Invite points: the project drive made last. */
    projectDrive: projects.at(-1),
    doneCount: steps.filter(s => s.done).length,
  };
}
