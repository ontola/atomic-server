import { core, useCurrentAgent, useString, type Resource } from '@tomic/react';
import type { JSX } from 'react';
import { FaCircleCheck, FaRegCircle } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { Button } from '@components/Button';
import { Card } from '@components/Card';
import { Column, Row } from '@components/Row';
import { useAISidebar } from '@components/AI/AISidebarContext';
import { openShareDialog } from '@components/Share/shareDialogState';
import { useIsPrivateDrive } from '@hooks/useIsPrivateDrive';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import {
  useOnboardingProgress,
  type OnboardingStep,
} from '@hooks/useOnboardingProgress';
import { paths } from '../../routes/paths';

/**
 * The first things worth trying, on the drive page of a drive of your own.
 * Every tick is derived from what exists, so deleting a project un-ticks it;
 * only "Hide" is remembered, on this device.
 */
export function GettingStartedCard({
  drive,
  canEdit,
}: {
  drive: Resource;
  canEdit: boolean;
}): JSX.Element | null {
  const [agent] = useCurrentAgent();
  const isPrivate = useIsPrivateDrive(drive.subject);
  // Whoever made the drive is its first writer; people invited later come after.
  const mine = (drive.get(core.properties.write) as string[] | undefined)?.[0];

  if (!canEdit || isPrivate || !agent || mine !== agent.subject) return null;

  // Keyed by agent: the hidden flag is stored per agent and read once.
  return <Steps key={agent.subject} drive={drive} />;
}

function Steps({ drive }: { drive: Resource }): JSX.Element | null {
  const [name] = useString(drive, core.properties.name);
  const { steps, projectDrive, doneCount, hidden, hide } =
    useOnboardingProgress(name);
  const { openChat } = useAISidebar();
  const navigate = useNavigateWithTransition();

  if (hidden || doneCount === steps.length) return null;

  const copy: Record<
    OnboardingStep['id'],
    { title: string; hint: string; action: string; run: () => void }
  > = {
    name: {
      title: 'Name your drive',
      hint: 'Give your drive a name: a project, company, team or household',
      action: 'Rename',
      run: () =>
        document
          .querySelector<HTMLElement>('h1[data-testid="editable-title"]')
          ?.click(),
    },
    project: {
      title: 'Start a project',
      hint: 'Pick a template for a team, a class or yourself',
      action: 'New project',
      run: () => navigate(paths.newDrive),
    },
    ai: {
      title: 'Talk to the AI',
      hint: 'Ask it to find, write or organize things in your drive',
      action: 'Start a chat',
      run: () => openChat(undefined, { withoutContext: true }),
    },
    invite: {
      title: 'Invite someone',
      hint: 'Share your project with a teammate or a friend',
      action: 'Invite',
      run: () => projectDrive && openShareDialog(projectDrive),
    },
    save: {
      title: 'Save your work',
      hint: 'Sign up with your email, save your secret or connect a device',
      action: 'Save',
      run: () => navigate(paths.sync),
    },
  };

  return (
    <Card aria-label='Getting started' data-testid='getting-started'>
      <Column gap='0.75rem'>
        <Row center gap='0.75rem'>
          <Heading>Getting started</Heading>
          <Count>
            {doneCount} of {steps.length}
          </Count>
          <Button subtle onClick={hide}>
            Hide
          </Button>
        </Row>
        {steps.map(step => {
          const { title, hint, action, run } = copy[step.id];
          const need =
            step.needs === 'project'
              ? 'Start a project first'
              : step.needs === 'ai-source'
                ? 'Needs an AI source: your own key or Ollama'
                : undefined;
          const blocked = step.needs === 'project';

          return (
            <Row key={step.id} center gap='0.75rem' data-done={step.done}>
              {step.done ? (
                <FaCircleCheck aria-label='Done' />
              ) : (
                <FaRegCircle aria-label='Not done yet' />
              )}
              <Text>
                <strong>{title}</strong>
                <small>{need ?? hint}</small>
              </Text>
              <Button
                subtle
                disabled={blocked}
                title={blocked ? need : undefined}
                onClick={run}
              >
                {step.needs === 'ai-source' ? 'Set up AI' : action}
              </Button>
            </Row>
          );
        })}
      </Column>
    </Card>
  );
}

const Heading = styled.h2`
  flex: 1;
  margin: 0;
  font-size: 1.1rem;
`;

const Count = styled.small`
  color: ${p => p.theme.colors.textLight};
`;

const Text = styled.span`
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;

  small {
    color: ${p => p.theme.colors.textLight};
  }
`;
