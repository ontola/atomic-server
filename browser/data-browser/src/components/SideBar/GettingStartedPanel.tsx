import {
  core,
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
import { useNewRoute } from '@helpers/useNewRoute';
import { openSaveWorkDialog } from '@components/SaveWork/saveWorkDialogState';
import {
  IconSlot,
  SideBarMenuRow,
  SideBarMenuRowLabel,
} from './SideBarMenuItem';
import { userSettingProps, useUserSetting } from '@hooks/useUserSetting';
import { SideBarPanel } from './SideBarPanel';
import { hideHoverUiHint, showUiHint, type UiHintTarget } from '@hooks/uiHint';

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
  const { steps, doneCount } = useOnboardingProgress(drive.subject, name);
  const [panelOpen, setPanelOpen] = useUserSetting<boolean>(
    userSettingProps.onboardingPanelOpen,
    'gettingStartedPanelHeight.open',
    true,
  );
  const { openChat } = useAISidebar();
  const portalUrl = useKnownPortalUrl();
  const navigate = useNavigateWithTransition();
  const navigateToNewRoute = useNewRoute(drive.subject);
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
      /** The callout text on the target. */
      pointer: string;
      run: () => void;
      target: UiHintTarget;
    }
  > = {
    name: {
      title: 'Name your drive',
      hint: 'Give your drive a name: a team, company, class or household',
      pointer: 'Click to name your drive',
      target: 'drive-title',
      run: () => {
        // The title on screen may belong to a document: go to the drive's own
        // page, where the hint points at that page's title.
        closeDrawer();
        navigate(constructOpenURL(drive.subject));
        showUiHint('drive-title', copy.name.pointer, {
          scope: drive.subject,
          force: true,
          nudge: true,
        });
      },
    },
    create: {
      title: 'Make something',
      hint: 'Add a document or table to this drive',
      pointer: 'Make a document or table here',
      target: 'new-row',
      run: () => {
        closeDrawer();
        pointAt('new-row', copy.create.pointer, navigateToNewRoute);
      },
    },
    ai: {
      title: 'Talk to the AI',
      hint: 'Ask it to find, write or organize things in your drive',
      pointer: 'Talk to the AI here',
      target: 'ai-button',
      run: () => {
        closeDrawer();
        pointAt('ai-button', copy.ai.pointer, () =>
          openChat(undefined, { withoutContext: true }),
        );
      },
    },
    invite: {
      title: 'Invite someone',
      hint: 'Share this drive with a teammate or a friend',
      pointer: 'Share this drive here',
      target: 'share-button',
      run: () => {
        closeDrawer();
        navigate(constructOpenURL(drive.subject));
        pointAt('share-button', copy.invite.pointer, () =>
          openShareDialog(drive.subject),
        );
      },
    },
    save: {
      title: portalUrl ? 'Save & register' : 'Save your work',
      hint: portalUrl
        ? 'Add your email to keep it safe on every device'
        : 'Connect a device to open your work on it',
      pointer: portalUrl ? 'Add your email here' : 'Connect a device here',
      target: 'save-row',
      run: () => pointAt('save-row', copy.save.pointer, openSaveWorkDialog),
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
        const { title, hint, pointer, run, target } = copy[step.id];
        const need =
          step.needs === 'ai-source'
            ? 'Needs an AI source: your own key or Ollama'
            : undefined;
        const inert = step.done;
        const tooltip = need ? `${hint}. ${need}` : hint;
        const hoverHint = () =>
          showUiHint(target, pointer, {
            hover: true,
            scope: step.id === 'name' ? drive.subject : undefined,
          });

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
              run();
            }}
            onPointerEnter={e => {
              if (!inert && e.pointerType === 'mouse') hoverHint();
            }}
            onPointerLeave={hideHoverUiHint}
            onFocus={e => {
              if (!inert && e.currentTarget.matches(':focus-visible'))
                hoverHint();
            }}
            onBlur={hideHoverUiHint}
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
    if (showUiHint(target, text, { scope, nudge: true })) return;
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
