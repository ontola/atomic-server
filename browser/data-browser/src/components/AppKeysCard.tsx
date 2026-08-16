import { useEffect, useId, useMemo, useState } from 'react';
import {
  core,
  grantAccessAgent,
  isRevokedAccessAgentName,
  issueAccessAgent,
  revokeAccessAgent,
  useChildren,
  useResource,
  useStore,
  useTitle,
} from '@tomic/react';
import { styled } from 'styled-components';
import { FaKey, FaPlus } from 'react-icons/fa6';
import toast from 'react-hot-toast';
import { Button } from './Button';
import { Card, CardInsideFull, CardRow } from './Card';
import { Column, Row } from './Row';
import { ErrorLook } from './ErrorLook';
import { SecretCodeBlock } from './SecretCodeBlock';
import { WarningBlock } from './WarningBlock';
import { Checkbox } from './forms/Checkbox';
import { RadioInput } from './forms/RadioInput';
import { InputStyled, InputWrapper, LabelStyled } from './forms/InputStyles';
import { Dialog, useDialog } from './Dialog';
import {
  ConfirmationDialog,
  ConfirmationDialogTheme,
} from './ConfirmationDialog';
import { getOrCreateAppKeysFolder } from '../helpers/appKeysFolder';
import { usePersonalDrive } from '../hooks/usePersonalDrive';
import { useSavedDrives } from '../hooks/useSavedDrives';

type AccessLevel = 'read' | 'write';

/**
 * Create, reuse, and revoke app keys — extra agents with their own secret,
 * granted only the workspaces you pick. The signed-in session stays you.
 */
export function AppKeysCard() {
  const store = useStore();
  const { personalDrive } = usePersonalDrive();
  const [savedDrives] = useSavedDrives();
  const [folderSubject, setFolderSubject] = useState<string>();
  const [folderError, setFolderError] = useState<string>();

  const workspaces = useMemo(() => {
    const subjects = [
      ...(personalDrive ? [personalDrive] : []),
      ...savedDrives.filter(subject => subject !== personalDrive),
    ];

    return [...new Set(subjects)];
  }, [personalDrive, savedDrives]);

  useEffect(() => {
    if (!personalDrive) {
      setFolderSubject(undefined);

      return;
    }

    let cancelled = false;

    void getOrCreateAppKeysFolder(store, personalDrive)
      .then(subject => {
        if (!cancelled) {
          setFolderSubject(subject);
          setFolderError(undefined);
        }
      })
      .catch(e => {
        if (!cancelled) {
          setFolderError(e instanceof Error ? e.message : String(e));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [store, personalDrive]);

  const { subjects: children } = useChildren(folderSubject);
  const [createProps, showCreate, closeCreate, createOpen] = useDialog();
  const [secret, setSecret] = useState<string>();

  if (!personalDrive) {
    return (
      <Card>
        App keys live on your private workspace. Create one first, then you can
        mint keys for apps and plugins.
      </Card>
    );
  }

  return (
    <>
      <Card>
        <Column gap='0.75rem'>
          <Row justify='space-between' align='center' wrapItems>
            <Explanation>
              Each key is its own identity. Give one to an app instead of your
              account secret.
            </Explanation>
            <Button
              onClick={() => {
                setSecret(undefined);
                showCreate();
              }}
              disabled={!folderSubject}
              data-test='create-app-key'
            >
              <FaPlus />
              Create key
            </Button>
          </Row>
          {folderError && <ErrorLook>{folderError}</ErrorLook>}
          <CardInsideFull>
            {children.length === 0 ? (
              <CardRow noBorder>
                No app keys yet. Create one for Raycast, a CLI, or any plugin
                that should not have your account secret.
              </CardRow>
            ) : (
              children.map((subject, index) => (
                <AppKeyRow
                  key={subject}
                  subject={subject}
                  workspaces={workspaces}
                  noBorder={index === 0}
                />
              ))
            )}
          </CardInsideFull>
        </Column>
      </Card>

      <Dialog
        {...createProps}
        width='28rem'
        disableLightDismiss={!!secret && createOpen}
      >
        {createOpen &&
          (secret ? (
            <CreatedSecret
              secret={secret}
              onDone={() => {
                setSecret(undefined);
                closeCreate(true);
              }}
            />
          ) : (
            <CreateKeyForm
              workspaces={workspaces}
              parent={folderSubject}
              onCreated={next => setSecret(next)}
              onCancel={() => closeCreate(false)}
            />
          ))}
      </Dialog>
    </>
  );
}

function AppKeyRow({
  subject,
  workspaces,
  noBorder,
}: {
  subject: string;
  workspaces: string[];
  noBorder?: boolean;
}) {
  const store = useStore();
  const resource = useResource(subject);
  const [title] = useTitle(resource);
  const [grantProps, showGrant, closeGrant, grantOpen] = useDialog();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aclEpoch, setAclEpoch] = useState(0);
  const revoked = isRevokedAccessAgentName(title ?? '');

  const access = useMemo(() => {
    let write = false;
    let read = false;
    const granted: string[] = [];

    for (const workspace of workspaces) {
      const drive = store.getResourceLoading(workspace);
      const readers = (drive.get(core.properties.read) as string[]) ?? [];
      const writers = (drive.get(core.properties.write) as string[]) ?? [];

      if (writers.includes(subject)) {
        write = true;
        read = true;
        granted.push(workspace);
      } else if (readers.includes(subject)) {
        read = true;
        granted.push(workspace);
      }
    }

    return { write, read, granted };
    // `aclEpoch` re-reads drive ACLs after grant/revoke; the store mutates
    // those resources in place so `workspaces` alone would not refresh.
  }, [store, subject, workspaces, aclEpoch]);

  const ungranted = workspaces.filter(w => !access.granted.includes(w));

  async function handleRevoke() {
    setBusy(true);

    try {
      const report = await revokeAccessAgent(store, subject, workspaces);
      setAclEpoch(n => n + 1);

      if (report.failed.length > 0) {
        // Never report a revoke that left access behind as done — the whole
        // point of the button is that the secret stops working.
        toast.error(
          `Still has access to ${report.failed.length} of ${workspaces.length} workspaces — could not revoke: ${report.failed
            .map(f => f.reason)
            .join('; ')}`,
        );
      } else {
        toast.success(
          `Key revoked — checked ${workspaces.length} workspace${
            workspaces.length === 1 ? '' : 's'
          }`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirmRevoke(false);
    }
  }

  return (
    <CardRow noBorder={noBorder}>
      <Row justify='space-between' align='center' wrapItems gap='0.75rem'>
        <Row gap='0.6rem' align='center'>
          <FaKey aria-hidden />
          <Column gap='0.15rem'>
            <KeyName>{title || 'Untitled key'}</KeyName>
            <KeyMeta>
              {revoked
                ? 'Revoked — this secret can no longer read your workspaces.'
                : access.write
                  ? `Read and write · ${workspaceCount(access.granted.length)}`
                  : access.read
                    ? `Read · ${workspaceCount(access.granted.length)}`
                    : 'No workspace access'}
            </KeyMeta>
          </Column>
        </Row>
        {!revoked && (
          <Row gap='0.5rem'>
            {ungranted.length > 0 && (
              <Button subtle onClick={showGrant} disabled={busy}>
                Add workspaces
              </Button>
            )}
            <Button
              subtle
              alert
              onClick={() => setConfirmRevoke(true)}
              disabled={busy}
              data-test='revoke-app-key'
            >
              Revoke
            </Button>
          </Row>
        )}
      </Row>

      <Dialog {...grantProps} width='24rem'>
        {grantOpen && (
          <GrantMoreForm
            agentSubject={subject}
            write={access.write}
            candidates={ungranted}
            onDone={() => {
              setAclEpoch(n => n + 1);
              closeGrant(true);
            }}
            onCancel={() => closeGrant(false)}
          />
        )}
      </Dialog>

      <ConfirmationDialog
        title='Revoke this key?'
        confirmLabel='Revoke'
        theme={ConfirmationDialogTheme.Alert}
        show={confirmRevoke}
        bindShow={setConfirmRevoke}
        onConfirm={() => void handleRevoke()}
      >
        Apps using this secret will lose access. You cannot show the secret
        again — create a new key if you still need one.
      </ConfirmationDialog>
    </CardRow>
  );
}

function CreateKeyForm({
  workspaces,
  parent,
  onCreated,
  onCancel,
}: {
  workspaces: string[];
  parent?: string;
  onCreated: (secret: string) => void;
  onCancel: () => void;
}) {
  const store = useStore();
  const nameId = useId();
  const [name, setName] = useState('');
  const [access, setAccess] = useState<AccessLevel>('read');
  const [selected, setSelected] = useState<string[]>(workspaces);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSelected(current => {
      const still = current.filter(s => workspaces.includes(s));

      return still.length > 0 ? still : workspaces;
    });
  }, [workspaces]);

  async function handleCreate() {
    setBusy(true);
    setError(undefined);

    try {
      const issued = await issueAccessAgent(store, {
        name,
        write: access === 'write',
        targets: selected,
        parent,
      });
      onCreated(issued.secret);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog.Title>
        <h1>Create an app key</h1>
      </Dialog.Title>
      <Dialog.Content>
        <Column gap='1rem'>
          <div>
            <LabelStyled htmlFor={nameId}>Name</LabelStyled>
            <InputWrapper>
              <InputStyled
                id={nameId}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder='Raycast'
                autoFocus
                data-test='app-key-name'
              />
            </InputWrapper>
          </div>

          <fieldset>
            <Legend>Access</Legend>
            <Column gap='0.4rem'>
              <RadioInput
                name='app-key-access'
                checked={access === 'read'}
                onChange={() => setAccess('read')}
              >
                Read only
              </RadioInput>
              <RadioInput
                name='app-key-access'
                checked={access === 'write'}
                onChange={() => setAccess('write')}
              >
                Read and write
              </RadioInput>
            </Column>
          </fieldset>

          <fieldset>
            <Legend>Workspaces</Legend>
            <Column gap='0.4rem'>
              {workspaces.length === 0 ? (
                <ErrorLook>No workspaces to grant yet.</ErrorLook>
              ) : (
                workspaces.map(subject => (
                  <WorkspaceCheck
                    key={subject}
                    subject={subject}
                    checked={selected.includes(subject)}
                    onChange={checked =>
                      setSelected(list =>
                        checked
                          ? [...list, subject]
                          : list.filter(s => s !== subject),
                      )
                    }
                  />
                ))
              )}
            </Column>
          </fieldset>
          {error && <ErrorLook>{error}</ErrorLook>}
        </Column>
      </Dialog.Content>
      <Dialog.Actions>
        <Button subtle onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() => void handleCreate()}
          disabled={busy || !name.trim() || selected.length === 0}
          data-test='app-key-create-confirm'
        >
          {busy ? 'Creating…' : 'Create key'}
        </Button>
      </Dialog.Actions>
    </>
  );
}

function GrantMoreForm({
  agentSubject,
  write,
  candidates,
  onDone,
  onCancel,
}: {
  agentSubject: string;
  write: boolean;
  candidates: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const store = useStore();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function handleGrant() {
    setBusy(true);
    setError(undefined);

    try {
      await grantAccessAgent(store, agentSubject, selected, write);
      toast.success('Access updated');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog.Title>
        <h1>Add workspaces</h1>
      </Dialog.Title>
      <Dialog.Content>
        <Column gap='0.75rem'>
          <p>
            Same key, more workspaces. The secret does not change — the app
            already holding it gets the new access.
          </p>
          {candidates.map(subject => (
            <WorkspaceCheck
              key={subject}
              subject={subject}
              checked={selected.includes(subject)}
              onChange={checked =>
                setSelected(list =>
                  checked
                    ? [...list, subject]
                    : list.filter(s => s !== subject),
                )
              }
            />
          ))}
          {error && <ErrorLook>{error}</ErrorLook>}
        </Column>
      </Dialog.Content>
      <Dialog.Actions>
        <Button subtle onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() => void handleGrant()}
          disabled={busy || selected.length === 0}
        >
          {busy ? 'Saving…' : 'Add access'}
        </Button>
      </Dialog.Actions>
    </>
  );
}

function CreatedSecret({
  secret,
  onDone,
}: {
  secret: string;
  onDone: () => void;
}) {
  return (
    <>
      <Dialog.Title>
        <h1>Copy this secret now</h1>
      </Dialog.Title>
      <Dialog.Content>
        <Column gap='1rem'>
          <WarningBlock>
            <WarningBlock.Title>
              You will not see this again.
            </WarningBlock.Title>
            Paste it into the app. If you lose it, revoke the key and create a
            new one.
          </WarningBlock>
          <SecretCodeBlock content={secret} />
        </Column>
      </Dialog.Content>
      <Dialog.Actions>
        <Button onClick={onDone} data-test='app-key-secret-done'>
          I have copied it
        </Button>
      </Dialog.Actions>
    </>
  );
}

function WorkspaceCheck({
  subject,
  checked,
  onChange,
}: {
  subject: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const resource = useResource(subject);
  const [title] = useTitle(resource);
  const id = useId();

  return (
    <Row gap='0.5rem' align='center'>
      <Checkbox
        id={id}
        checked={checked}
        onChange={onChange}
        aria-label={title || subject}
      />
      <label htmlFor={id}>{title || subject}</label>
    </Row>
  );
}

function workspaceCount(n: number): string {
  return n === 1 ? '1 workspace' : `${n} workspaces`;
}

const Explanation = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
  max-width: 40ch;
`;

const KeyName = styled.span`
  font-weight: 600;
`;

const KeyMeta = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9em;
`;

const Legend = styled.legend`
  font-weight: bold;
  padding: 0;
  margin-bottom: 0.4rem;
`;
