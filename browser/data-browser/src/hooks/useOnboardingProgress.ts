// @wc-ignore-file
import { core, urls, useCurrentAgent, useResources } from '@tomic/react';
import { canonicalizeScheme } from '@tomic/lib';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useDriveChats } from '@components/SideBar/AIPanel';
import { readManagedAccountBinding } from '@helpers/managed/binding';
import { isDeviceLinked } from '@helpers/managed/deviceLink';
import { useLocalStorage } from './useLocalStorage';
import { usePrivateDrive } from './usePrivateDrive';
import { useSavedDrives } from './useSavedDrives';

export type OnboardingStepId = 'name' | 'project' | 'ai' | 'invite' | 'save';

/** What a step is waiting for before its button can do anything. */
export type OnboardingNeed = 'project' | 'ai-source';

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
  needs?: OnboardingNeed;
}

/**
 * The card keeps three local flags per agent. Nothing is written to a drive:
 * what the card shows is derived from what exists, and these only remember a
 * choice or a fact that leaves no trace to derive from.
 */
export const onboardingKeys = {
  hidden: (agent?: string) => `atomic.gettingStarted.hidden:${agent}`,
  /** The drive `startWelcomeDrive` made; it stays the Welcome drive when renamed. */
  welcomeDrive: (agent?: string) => `atomic.gettingStarted.welcome:${agent}`,
  /** An invite link was made. Joining leaves rights; a link nobody used does not. */
  invited: (agent?: string) => `atomic.gettingStarted.invited:${agent}`,
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
  invited: boolean;
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
      done: input.invited || input.otherAgentsOnProjects,
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
  const [welcomeDrive] = useLocalStorage<string | undefined>(
    onboardingKeys.welcomeDrive(agent?.subject),
    undefined,
  );
  const [invited] = useLocalStorage(
    onboardingKeys.invited(agent?.subject),
    false,
  );
  const [hidden, setHidden] = useLocalStorage(
    onboardingKeys.hidden(agent?.subject),
    false,
  );
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
    invited,
    accountLinked: !!readManagedAccountBinding() || isDeviceLinked(),
  };
  const steps = deriveOnboardingSteps(input);

  return {
    steps,
    /** Where Invite points: the project drive made last. */
    projectDrive: projects.at(-1),
    doneCount: steps.filter(s => s.done).length,
    hidden,
    hide: () => setHidden(true),
  };
}
