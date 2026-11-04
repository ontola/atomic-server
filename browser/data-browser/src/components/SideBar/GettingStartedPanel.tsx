import {
  core,
  server,
  useCurrentAgent,
  useArray,
  useCanWrite,
  useResource,
  useString,
  type Resource,
} from '@tomic/react';
import type { JSX } from 'react';
import { FaCircleCheck, FaRegCircle } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { useSettings } from '@helpers/AppSettings';
import { useAISidebar } from '@components/AI/AISidebarContext';
import { openShareDialog } from '@components/Share/shareDialogState';
import { constructOpenURL } from '@helpers/navigation';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { useKnownPortalUrl } from '@hooks/useKnownPortalUrl';
import { useIsPrivateDrive } from '@hooks/useIsPrivateDrive';
import {
  useOnboardingProgress,
  type OnboardingStep,
} from '@hooks/useOnboardingProgress';
import { useNewResourceUI } from '@components/forms/NewForm/useNewResourceUI';
import { openSaveWorkDialog } from '@components/SaveWork/saveWorkDialogState';
import {
  IconSlot,
  SideBarMenuRow,
  SideBarMenuRowLabel,
} from './SideBarMenuItem';
import { userSettingProps, useUserSetting } from '@hooks/useUserSetting';
import { SideBarPanel } from './SideBarPanel';
import {
  dismissUiHint,
  previewUiHint,
  showUiHint,
  type UiHintTarget,
} from '@hooks/uiHint';

/**
 * The first things worth trying, as a sidebar panel on a drive of your own.
 * Every tick is derived from what exists, so deleting a drive un-ticks it.
 * Folding the panel is the panel's own, always reversible; it goes away by
 * itself once every step is done.
 */
export function GettingStartedPanel(): JSX.Element | null {
  const { drive } = useSettings();
  const resource = useResource(drive);
  const canEdit = useCanWrite(resource);
  const [agent] = useCurrentAgent();
  const isPrivate = useIsPrivateDrive(resource.subject);
  // Whoever made the drive is its first writer; people invited later come after.
  const [writers] = useArray(resource, core.properties.write);
  const mine = writers?.[0];

  return canEdit && !isPrivate && agent && mine === agent.subject ? (
    <Steps drive={resource} />
  ) : null;
}

function Steps({ drive }: { drive: Resource }): JSX.Element | null {
  const [name] = useString(drive, core.properties.name);
  const { steps, projectDrive, doneCount } = useOnboardingProgress(name);
  const [panelOpen, setPanelOpen] = useUserSetting<boolean>(
    userSettingProps.onboardingPanelOpen,
    'gettingStartedPanelHeight.open',
    true,
  );
  const { openChat } = useAISidebar();
  const createNewResource = useNewResourceUI();
  const [agent] = useCurrentAgent();
  const portalUrl = useKnownPortalUrl();
  const navigate = useNavigateWithTransition();
  const { setSideBarLocked } = useSettings();

  // Hints on the page need the drawer out of the way; sidebar ones are
  // already in view, since the step was clicked there.
  const closeDrawer = () => {
    if (sidebarCoversPage()) setSideBarLocked(false);
  };

  if (doneCount === steps.length) return null;

  const copy: Record<
    OnboardingStep['id'],
    {
      title: string;
      hint: string;
      run: () => void;
      target: UiHintTarget;
    }
  > = {
    name: {
      title: 'Name your drive',
      hint: 'Give your drive a name: a team, company, class or household',
      target: 'drive-title',
      run: () => {
        // The title on screen may belong to a document: go to the drive's own
        // page, where the hint points at that page's title.
        closeDrawer();
        navigate(constructOpenURL(drive.subject));
        showUiHint('drive-title', 'Click to name your drive', {
          scope: drive.subject,
          force: true,
        });
      },
    },
    project: {
      title: 'Start a drive',
      hint: 'Fill it with a starter',
      target: 'drive-switcher',
      run: () =>
        pointAt('drive-switcher', 'Make a new drive here', () =>
          createNewResource(server.classes.drive, agent?.subject ?? ''),
        ),
    },
    ai: {
      title: 'Talk to the AI',
      hint: 'Ask it to find, write or organize things in your drive',
      target: 'ai-button',
      run: () => {
        closeDrawer();
        pointAt('ai-button', 'Talk to the AI here', () =>
          openChat(undefined, { withoutContext: true }),
        );
      },
    },
    invite: {
      title: 'Invite someone',
      hint: 'Share a drive with a teammate or a friend',
      target: 'share-button',
      run: () => {
        if (!projectDrive) return;
        closeDrawer();
        navigate(constructOpenURL(projectDrive));
        pointAt('share-button', 'Share a drive here', () =>
          openShareDialog(projectDrive),
        );
      },
    },
    save: {
      title: portalUrl ? 'Save & register' : 'Save your work',
      hint: portalUrl
        ? 'Add your email to keep it safe on every device'
        : 'Connect a device to open your work on it',
      target: 'save-row',
      run: () =>
        pointAt(
          'save-row',
          portalUrl ? 'Add your email here' : 'Connect a device here',
          openSaveWorkDialog,
        ),
    },
  };

  return (
    <SideBarPanel
      title='Getting started'
      heightStorageKey='gettingStartedPanelHeight'
      initialHeight={280}
      open={panelOpen}
      onOpenChange={setPanelOpen}
      data-testid='getting-started'
      actions={
        <Count>
          {doneCount} of {steps.length}
        </Count>
      }
    >
      {steps.map(step => {
        const { title, hint, run, target } = copy[step.id];
        const need =
          step.needs === 'project'
            ? 'Start a drive first'
            : step.needs === 'ai-source'
              ? 'Needs an AI source: your own key or Ollama'
              : undefined;
        const blocked = step.needs === 'project';
        const inert = blocked || step.done;
        const tooltip = blocked ? need : need ? `${hint}. ${need}` : hint;

        return (
          <StepRow
            key={step.id}
            as='button'
            type='button'
            disabled={inert}
            aria-disabled={inert}
            title={tooltip}
            data-done={step.done}
            onClick={() => {
              previewUiHint(undefined);
              dismissUiHint();
              run();
            }}
            onPointerEnter={e => {
              if (!inert && e.pointerType === 'mouse') previewUiHint(target);
            }}
            onPointerLeave={() => previewUiHint(undefined)}
            onFocus={e => {
              if (!inert && e.currentTarget.matches(':focus-visible'))
                previewUiHint(target);
            }}
            onBlur={() => previewUiHint(undefined)}
          >
            <IconSlot aria-hidden>
              {step.done ? <FaCircleCheck /> : <FaRegCircle />}
            </IconSlot>
            <SideBarMenuRowLabel>{title}</SideBarMenuRowLabel>
          </StepRow>
        );
      })}
    </SideBarPanel>
  );
}

/**
 * Points at where the step is done, so people learn where things live. Falls
 * back to doing the step when that place is not on screen (a top bar item in
 * a More menu, say), waiting a moment for the page just navigated to.
 */
function pointAt(
  target: UiHintTarget,
  text: string,
  fallback: () => void,
  scope?: string,
): void {
  const deadline = Date.now() + 3000;

  const attempt = () => {
    if (showUiHint(target, text, { scope })) return;
    if (Date.now() < deadline) setTimeout(attempt, 100);
    else fallback();
  };

  attempt();
}

/** Below the width where the sidebar is a drawer over the page (see SideBar). */
const sidebarCoversPage = () => window.matchMedia('(max-width: 599px)').matches;

/** A sidebar menu row that is a button: same box, font and hover as the rest. */
const StepRow = styled(SideBarMenuRow)`
  border: 0;
  font: inherit;
  cursor: pointer;

  &:disabled {
    color: ${p => p.theme.colors.textLight};
    cursor: default;
    opacity: 0.6;
    background-color: transparent;
  }
`;

const Count = styled.small`
  white-space: nowrap;
  padding-right: 0.5rem;
  color: ${p => p.theme.colors.textLight};
`;
