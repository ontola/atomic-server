import React, {
  FormEvent,
  Suspense,
  useCallback,
  useId,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { useStore, type Resource } from '@tomic/react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { useSettings } from '@helpers/AppSettings';
import { constructOpenURL } from '@helpers/navigation';
import { driveNameFromPrompt } from '@helpers/driveNameFromPrompt';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { Button } from '@components/Button';
import { Column, Row } from '@components/Row';
import Field from '@components/forms/Field';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { LoaderBlock } from '@components/Loader';
import { newContextItem } from '@components/AI/AISidebarContext';
import { DRIVE_SETUP_SKILL_NAME } from '@chunks/AI/skills/driveSetupSkill';
import type {
  AIMessageContext,
  AISkillMessageContext,
  AtomicUIMessage,
} from '@chunks/AI/types';

const RealAIChat = React.lazy(() =>
  import('@chunks/AI/RealAIChat').then(module => ({
    default: module.RealAIChat,
  })),
);

const STARTER_PROMPTS = [
  'A CRM for my sales team',
  'Personal notes and tasks',
  'Issues and projects for a software team',
];

export interface NewDriveSetupProps {
  onCreated?: (resource: Resource) => void;
  onClose?: () => void;
  skipNavigation?: boolean;
  createLabel?: string;
  showCancel?: boolean;
}

export function NewDriveSetup({
  onCreated,
  onClose,
  skipNavigation,
  createLabel = 'Create',
  showCancel = true,
}: NewDriveSetupProps): React.JSX.Element {
  const store = useStore();
  const nameFieldId = useId();
  const { setDrive } = useSettings();
  const navigate = useNavigateWithTransition();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [createdDrive, setCreatedDrive] = useState<Resource | undefined>();
  const [contextItems, setContextItems] = useState<AIMessageContext[]>(() => [
    newContextItem<AISkillMessageContext>({
      type: 'skill',
      name: DRIVE_SETUP_SKILL_NAME,
    }),
  ]);

  const goToDrive = useCallback(
    (resource: Resource) => {
      if (!skipNavigation) {
        navigate(constructOpenURL(resource.subject));
      }
    },
    [navigate, skipNavigation],
  );

  const createDrive = useCallback(
    async (driveName: string) => {
      const resource = await store.createDrive(driveName, { personal: false });
      store.notifyResourceManuallyCreated(resource);
      store.setDrive(resource.subject);
      // Tools and `useAddToOntology` close over the React drive. Flush so the
      // first setup message writes to this drive, not the previous one.
      flushSync(() => {
        setDrive(resource.subject);
        setCreatedDrive(resource);
      });
      onCreated?.(resource);

      return resource;
    },
    [onCreated, setDrive, store],
  );

  const handleEmptyCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();

    if (!trimmed || busy || createdDrive) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      const resource = await createDrive(trimmed);
      toast.success('Drive created');
      goToDrive(resource);
      onClose?.();
    } catch (err) {
      const asError =
        err instanceof Error ? err : new Error('Could not create the drive.');
      store.notifyError(asError);
      setError(asError);
      toast.error('Failed to create drive');
    } finally {
      setBusy(false);
    }
  };

  const handleBeforeChatSubmit = async (text: string) => {
    if (createdDrive) {
      return;
    }

    try {
      await createDrive(driveNameFromPrompt(text));
    } catch (err) {
      const asError =
        err instanceof Error ? err : new Error('Could not create the drive.');
      store.notifyError(asError);
      throw asError;
    }
  };

  const handleDone = () => {
    if (createdDrive) {
      goToDrive(createdDrive);
    }

    onClose?.();
  };

  return (
    <Column gap='1.5rem'>
      <Intro>
        <p>
          What do you want to use this drive for? Describe a project, team, or
          workflow. You can paste a company website and the assistant will
          figure out the rest.
        </p>
      </Intro>
      <ChatShell>
        <Suspense fallback={<LoaderBlock />}>
          <RealAIChat
            embedded
            externalContextItems={contextItems}
            setExternalContextItems={setContextItems}
            onNewMessage={noopMessage}
            onDeleteMessage={noopMessage}
            onRegenerateMessage={noopMessage}
            onBeforeSubmit={handleBeforeChatSubmit}
            starterPrompts={STARTER_PROMPTS}
          />
        </Suspense>
      </ChatShell>
      {!createdDrive && (
        <form onSubmit={handleEmptyCreate}>
          <Column gap='1rem'>
            <Field
              required
              label='Name'
              fieldId={nameFieldId}
              error={error}
              helper='Skip the chat and create an empty drive.'
            >
              <InputWrapper>
                <InputStyled
                  id={nameFieldId}
                  placeholder='My Drive'
                  value={name}
                  onChange={event => setName(event.target.value)}
                />
              </InputWrapper>
            </Field>
            <Row gap='1rem' justify='flex-end'>
              {showCancel && (
                <Button type='button' onClick={onClose} subtle>
                  Cancel
                </Button>
              )}
              <Button
                type='submit'
                disabled={busy || !name.trim()}
                loading={busy ? 'Creating…' : undefined}
              >
                {createLabel}
              </Button>
            </Row>
          </Column>
        </form>
      )}
      {createdDrive && (
        <Row gap='1rem' justify='flex-end'>
          <Button onClick={handleDone}>Done</Button>
        </Row>
      )}
    </Column>
  );
}

const noopMessage = (_message: AtomicUIMessage) => undefined;

const Intro = styled.div`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.95rem;

  p {
    margin: 0;
  }
`;

const ChatShell = styled.div`
  min-height: 22rem;
  height: min(50vh, 32rem);
  display: flex;
  flex-direction: column;

  & > * {
    flex: 1;
    min-height: 0;
  }
`;
