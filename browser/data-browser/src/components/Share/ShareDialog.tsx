import React, { cloneElement, isValidElement, useState, type JSX } from 'react';
import { useCanWrite, useResource, useStore } from '@tomic/react';
import { Dialog, useDialog } from '../Dialog';
import { Button } from '../Button';
import { InviteForm } from '../InviteForm';
import toast from 'react-hot-toast';
import { Title } from '../Title';
import { ErrorLook } from '../ErrorLook';
import { Column } from '../Row';
import { FaLink, FaShare } from 'react-icons/fa6';
import { useRights } from '../../routes/Share/useRights';
import { AgentRights } from '../../routes/Share/AgentRights';
import { useInheritedRights } from '../../routes/Share/useInheritedRights';
import { PermissionRow } from '../../routes/Share/PermissionRow';
import styled from 'styled-components';

export interface ShareDialogProps {
  subject: string;
  trigger: JSX.Element;
}

/** Dialog for managing and viewing rights for a resource */
export function ShareDialog({
  subject,
  trigger,
}: ShareDialogProps): JSX.Element {
  const [dialogProps, show, , isOpen] = useDialog();
  const resource = useResource(subject);
  const canWrite = useCanWrite(resource);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [err, setErr] = useState<Error | undefined>(undefined);
  const inheritedRights = useInheritedRights(resource);
  const [resourceRights, updateResourceRights] = useRights(resource, setErr);

  const handleSave = async () => {
    try {
      await resource.save();
      toast.success('Share settings saved');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    show();
  };

  const triggerEl = trigger as React.ReactElement<{
    onClick?: (e: React.MouseEvent) => void;
  }>;
  const triggerWithOpen = isValidElement(trigger)
    ? cloneElement(triggerEl, {
        onClick: (e: React.MouseEvent) => {
          triggerEl.props.onClick?.(e);
          handleTriggerClick(e);
        },
      })
    : trigger;

  return (
    <>
      {triggerWithOpen}
      <Dialog {...dialogProps} width='500px'>
        {isOpen && (
          <>
            <Dialog.Title>
              <Title resource={resource} prefix='Share' />
            </Dialog.Title>
            <Dialog.Content>
              <Column gap='1rem'>
                <CopyLinkButton subject={subject} />
                {canWrite && !showInviteForm && (
                  <Button onClick={() => setShowInviteForm(true)}>
                    <FaShare />
                    Create Invite
                  </Button>
                )}
                {showInviteForm && <InviteForm target={resource} />}
                <RightsCard>
                  <Column>
                    <RightsHeader>Permissions set here:</RightsHeader>
                    {resourceRights.map(right => (
                      <AgentRights
                        hideInherit
                        key={JSON.stringify(right)}
                        {...right}
                        handleSetRight={
                          canWrite && resource.isReady()
                            ? updateResourceRights
                            : undefined
                        }
                      />
                    ))}
                  </Column>
                </RightsCard>
                {canWrite && (
                  <Button
                    disabled={!resource.hasUnsavedChanges()}
                    onClick={handleSave}
                  >
                    Save
                  </Button>
                )}
                {err && <ErrorLook>{err.message}</ErrorLook>}
                {inheritedRights.length > 0 && (
                  <RightsCard>
                    <Column>
                      <RightsHeader>Inherited permissions:</RightsHeader>
                      {inheritedRights.map(right => (
                        <AgentRights
                          setIn={right.setIn}
                          key={right.agentSubject + right.setIn}
                          read={right.read}
                          write={right.write}
                          agentSubject={right.agentSubject}
                        />
                      ))}
                    </Column>
                  </RightsCard>
                )}
                <p>
                  Read more about permissions in the{' '}
                  <a
                    target='_blank'
                    href='https://docs.atomicdata.dev/hierarchy'
                    rel='noreferrer'
                  >
                    Atomic Data Docs
                  </a>
                </p>
              </Column>
            </Dialog.Content>
          </>
        )}
      </Dialog>
    </>
  );
}

const RightsCard = styled.div`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
`;

function CopyLinkButton({ subject }: { subject: string }): JSX.Element {
  const store = useStore();

  const handleCopy = () => {
    // Build a full URL that can be opened in a browser.
    // For DID subjects, use the server URL + DID path.
    let link: string;

    if (subject.startsWith('did:')) {
      const server = store.getServerUrl().replace(/\/$/, '');
      link = `${server}/${subject}`;
    } else {
      link = subject;
    }

    navigator.clipboard.writeText(link);
    toast.success('Link copied to clipboard');
  };

  return (
    <Button subtle onClick={handleCopy}>
      <FaLink />
      Copy link
    </Button>
  );
}

function RightsHeader({ children }: React.PropsWithChildren): JSX.Element {
  return (
    <PermissionRow>
      <PermissionRow.TitleColumn>{children}</PermissionRow.TitleColumn>
      <PermissionRow.ControlsColumn>
        <span>Read</span>
        <span>Write</span>
      </PermissionRow.ControlsColumn>
    </PermissionRow>
  );
}
