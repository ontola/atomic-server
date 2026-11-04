import {
  core,
  server,
  useCurrentAgent,
  useCanWrite,
  useResource,
  useString,
  type Resource,
} from '@tomic/react';
import type { JSX } from 'react';
import { FaCircleCheck, FaRegCircle } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { Button } from '@components/Button';
import { Column, Row } from '@components/Row';
import { useSettings } from '@helpers/AppSettings';
import { useAISidebar } from '@components/AI/AISidebarContext';
import { openShareDialog } from '@components/Share/shareDialogState';
import { useKnownPortalUrl } from '@hooks/useKnownPortalUrl';
import { useIsPrivateDrive } from '@hooks/useIsPrivateDrive';
import {
  useOnboardingProgress,
  type OnboardingStep,
} from '@hooks/useOnboardingProgress';
import { useNewResourceUI } from '@components/forms/NewForm/useNewResourceUI';
import { openSaveWorkDialog } from '@components/SaveWork/saveWorkDialogState';
import { SideBarPanel } from './SideBarPanel';

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
  const mine = (
    resource.get(core.properties.write) as string[] | undefined
  )?.[0];

  return canEdit && !isPrivate && agent && mine === agent.subject ? (
    <Steps drive={resource} />
  ) : null;
}

function Steps({ drive }: { drive: Resource }): JSX.Element | null {
  const [name] = useString(drive, core.properties.name);
  const { steps, projectDrive, doneCount } = useOnboardingProgress(name);
  const { openChat } = useAISidebar();
  const createNewResource = useNewResourceUI();
  const [agent] = useCurrentAgent();
  const portalUrl = useKnownPortalUrl();

  if (doneCount === steps.length) return null;

  const copy: Record<
    OnboardingStep['id'],
    { title: string; hint: string; action: string; run: () => void }
  > = {
    name: {
      title: 'Name your drive',
      hint: 'Give your drive a name: a team, company, class or household',
      action: 'Rename',
      run: () =>
        document
          .querySelector<HTMLElement>('h1[data-testid="editable-title"]')
          ?.click(),
    },
    project: {
      title: 'Start a drive',
      hint: 'Fill it with a starter',
      action: 'New drive',
      run: () => createNewResource(server.classes.drive, agent?.subject ?? ''),
    },
    ai: {
      title: 'Talk to the AI',
      hint: 'Ask it to find, write or organize things in your drive',
      action: 'Start a chat',
      run: () => openChat(undefined, { withoutContext: true }),
    },
    invite: {
      title: 'Invite someone',
      hint: 'Share a drive with a teammate or a friend',
      action: 'Invite',
      run: () => projectDrive && openShareDialog(projectDrive),
    },
    save: {
      title: 'Save your work',
      hint: portalUrl
        ? 'Add your email to keep it safe on every device'
        : 'Connect a device to open your work on it',
      action: 'Save',
      run: openSaveWorkDialog,
    },
  };

  return (
    <SideBarPanel
      title='Getting started'
      heightStorageKey='gettingStartedPanelHeight'
      initialHeight={280}
      data-testid='getting-started'
      actions={
        <Count>
          {doneCount} of {steps.length}
        </Count>
      }
    >
      <Column gap='0.5rem'>
        {steps.map(step => {
          const { title, hint, action, run } = copy[step.id];
          const need =
            step.needs === 'project'
              ? 'Start a drive first'
              : step.needs === 'ai-source'
                ? 'Needs an AI source: your own key or Ollama'
                : undefined;
          const blocked = step.needs === 'project';

          return (
            <StepRow key={step.id} center gap='0.5rem' data-done={step.done}>
              {step.done ? (
                <FaCircleCheck aria-label='Done' />
              ) : (
                <FaRegCircle aria-label='Not done yet' />
              )}
              <Text title={hint}>
                <strong>{title}</strong>
                {need && <small>{need}</small>}
              </Text>
              <ActionButton
                subtle
                disabled={blocked}
                title={blocked ? need : undefined}
                onClick={run}
              >
                {step.needs === 'ai-source' ? 'Set up AI' : action}
              </ActionButton>
            </StepRow>
          );
        })}
      </Column>
    </SideBarPanel>
  );
}

const StepRow = styled(Row)`
  padding-inline: 0.5rem;
  font-size: 0.85rem;
  line-height: 1.25;
`;

const ActionButton = styled(Button)`
  flex-shrink: 0;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
  white-space: nowrap;
`;

const Count = styled.small`
  white-space: nowrap;
  padding-right: 0.5rem;
  color: ${p => p.theme.colors.textLight};
`;

const Text = styled.span`
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;

  small {
    font-size: 0.7rem;
    color: ${p => p.theme.colors.textLight};
  }
`;
