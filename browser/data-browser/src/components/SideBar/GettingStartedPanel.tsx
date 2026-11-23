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
import { Dialog, useDialog } from '../Dialog';
import { NewMessageDialogBody } from '@views/Conversation/NewMessageDialog';
import { BUILD_APP_PROMPT } from '@components/AI/buildAppPrompt';
import { UiHint } from '../UiHint';
import { SectionTitle } from '@views/Drive/SectionTitle';

/** Where the list is shown: the sidebar panel, or a section of the drive page. */
export type GettingStartedPlacement = 'sidebar' | 'page';

/**
 * The first things worth trying, on a drive of your own: a sidebar panel, or a
 * section of the drive page (so it is also found where the sidebar is closed).
 * Every tick is derived from what exists, so deleting a drive un-ticks it.
 * Folding the panel is the panel's own, always reversible; it goes away by
 * itself once every step is done.
 */
export function GettingStartedPanel({
  placement = 'sidebar',
}: {
  placement?: GettingStartedPlacement;
}): JSX.Element | null {
  const { drive } = useSettings();
  const resource = useResource(drive);
  const canEdit = useCanWrite(resource);
  const [agent] = useCurrentAgent();
  const isPrivate = useIsPrivateDrive(resource.subject);
  // Whoever made the drive is its first writer; people invited later come after.
  const [writers] = useArray(resource, core.properties.write);
  const mine = writers?.[0];

  return canEdit && !isPrivate && agent && mine === agent.subject ? (
    <Steps drive={resource} placement={placement} />
  ) : null;
}

/** Targets that live in the sidebar, which is a drawer on a narrow screen. */
const SIDEBAR_TARGETS: UiHintTarget[] = ['new-row'];

function Steps({
  drive,
  placement,
}: {
  drive: Resource;
  placement: GettingStartedPlacement;
}): JSX.Element | null {
  const [name] = useString(drive, core.properties.name);
  const progress = useOnboardingProgress(drive.subject, name);
  // Once the basics are done the panel moves on to the advanced round.
  const advanced = progress.doneCount === progress.steps.length;
  const steps = advanced ? progress.advancedSteps : progress.steps;
  const doneCount = advanced ? progress.advancedDoneCount : progress.doneCount;
  const [panelOpen, setPanelOpen] = useUserSetting<boolean>(
    userSettingProps.onboardingPanelOpen,
    'gettingStartedPanelHeight.open',
    true,
  );
  const { openChat, askAI } = useAISidebar();
  const [dialogProps, showMessageDialog, closeMessageDialog, messageOpen] =
    useDialog();
  const navigate = useNavigateWithTransition();
  const navigateToNewRoute = useNewRoute(drive.subject);
  const { setSideBarLocked } = useSettings();

  // The hint's target has to be in view. From the sidebar drawer that means
  // closing it, for a target on the page. From the page it means opening it,
  // for a target in the sidebar.
  const closeDrawer = (target: UiHintTarget) => {
    if (!sidebarCoversPage()) return;
    setSideBarLocked(placement === 'page' && SIDEBAR_TARGETS.includes(target));
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
      /** Absent when the step opens its own dialog instead of pointing. */
      target?: UiHintTarget;
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
        closeDrawer('drive-title');
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
        closeDrawer('new-row');
        pointAt('new-row', copy.create.pointer, navigateToNewRoute);
      },
    },
    ai: {
      title: 'Talk to the AI',
      hint: 'Ask it to find, write or organize things in your drive',
      pointer: 'Talk to the AI here',
      target: 'ai-button',
      run: () => {
        closeDrawer('ai-button');
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
        closeDrawer('share-button');
        navigate(constructOpenURL(drive.subject));
        pointAt('share-button', copy.invite.pointer, () =>
          openShareDialog(drive.subject),
        );
      },
    },
    save: {
      title: 'Save your work',
      hint: 'Register your email or connect a device to open it elsewhere',
      pointer: 'Save your work here',
      target: 'save-row',
      run: openSaveWorkDialog,
    },
    table: {
      title: 'Make a table',
      hint: 'Tables with your own columns, like a small database',
      pointer: 'Make a table here',
      target: 'new-row',
      run: () => {
        closeDrawer('new-row');
        pointAt('new-row', copy.table.pointer, navigateToNewRoute);
      },
    },
    form: {
      title: 'Make a form',
      hint: 'Collect answers from anyone with a link',
      pointer: 'Make a form here',
      target: 'new-row',
      run: () => {
        closeDrawer('new-row');
        pointAt('new-row', copy.form.pointer, navigateToNewRoute);
      },
    },
    app: {
      title: 'Build an app with AI',
      hint: 'Describe what you need and the AI builds it in your drive',
      pointer: 'Build an app with AI here',
      target: 'ai-button',
      run: () => {
        closeDrawer('ai-button');
        // The hint shows where the AI lives; the ask goes out either way.
        pointAt('ai-button', copy.app.pointer, () => {});
        askAI({ prompt: BUILD_APP_PROMPT });
      },
    },
    message: {
      title: 'Send someone a message',
      hint: 'Write to someone you invited, like a colleague or friend',
      pointer: 'Send a message here',
      run: showMessageDialog,
    },
  };

  const count = (
    <Count>
      {doneCount} of {steps.length}
    </Count>
  );

  const rows = (
    <>
      <Dialog {...dialogProps} width='30rem'>
        {messageOpen && <NewMessageDialogBody onDone={closeMessageDialog} />}
      </Dialog>
      {steps.map(step => {
        const { title, hint, pointer, run, target } = copy[step.id];

        // Not yet saved: the step is the guest's next move, a row with its own
        // warning, and it opens the Save dialog in place.
        if (step.id === 'save' && !step.done) {
          return (
            <UiHint key={step.id} target='save-row'>
              <SaveRow
                as='button'
                type='button'
                onClick={run}
                data-testid='guest-save-row'
                data-done={false}
              >
                <IconSlot aria-hidden>
                  <FaRegCircle />
                </IconSlot>
                <SaveText>
                  <SaveAction>{title}</SaveAction>
                  <SaveNote>Only saved on this device</SaveNote>
                </SaveText>
              </SaveRow>
            </UiHint>
          );
        }

        const need =
          step.needs === 'ai-source'
            ? 'Needs an AI source: your own key or Ollama'
            : undefined;
        const inert = step.done;
        const tooltip = need ? `${hint}. ${need}` : hint;

        const hoverHint = () => {
          // A drawer that is out of view has nothing to point at.
          if (!target) return;

          if (
            placement === 'page' &&
            sidebarCoversPage() &&
            SIDEBAR_TARGETS.includes(target)
          )
            return;

          showUiHint(target, pointer, {
            hover: true,
            scope: step.id === 'name' ? drive.subject : undefined,
          });
        };

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
    </>
  );

  if (placement === 'page') {
    return (
      <section
        aria-label={advanced ? 'Next steps' : 'Getting started'}
        data-testid='getting-started-page'
      >
        <SectionHeading>
          <SectionTitle>
            {advanced ? 'Next steps' : 'Getting started'}
          </SectionTitle>
          {count}
        </SectionHeading>
        <PageSteps>{rows}</PageSteps>
      </section>
    );
  }

  return (
    <SideBarPanel
      title={advanced ? 'Next steps' : 'Getting started'}
      heightStorageKey='gettingStartedPanelHeight'
      initialHeight={280}
      open={panelOpen}
      onOpenChange={setPanelOpen}
      data-testid='getting-started'
      actions={count}
    >
      {rows}
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
): void {
  const deadline = Date.now() + 3000;

  const attempt = () => {
    if (showUiHint(target, text, { nudge: true })) return;
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

const SaveRow = styled(StepRow)`
  padding-inline-end: 0.5rem;
  padding-block: 0.25rem;

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
    outline-offset: -2px;
  }
`;

const SaveText = styled.span`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  text-align: start;
  line-height: 1.25;
`;

const SaveAction = styled(SideBarMenuRowLabel)`
  flex: none;
  color: ${p => p.theme.colors.main};
`;

const SaveNote = styled(SideBarMenuRowLabel)`
  flex: none;
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
`;

const Count = styled.small`
  white-space: nowrap;
  padding-right: 0.5rem;
  color: ${p => p.theme.colors.textLight};
`;

const SectionHeading = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;

  h2 {
    margin: 0;
  }
`;

const PageSteps = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  max-width: 28rem;
`;
