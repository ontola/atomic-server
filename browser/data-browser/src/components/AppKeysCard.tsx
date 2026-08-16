import { useEffect, useId, useMemo, useState } from 'react';
import {
  core,
  dataBrowser,
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
import { SearchBox } from './forms/SearchBox';
import { getOrCreateAppKeysFolder } from '../helpers/appKeysFolder';
import { usePersonalDrive } from '../hooks/usePersonalDrive';
import { useSavedDrives } from '../hooks/useSavedDrives';

const ADD_TARGET_PLACEHOLDER = 'Add a folder, page, or other resource';

type AccessLevel = 'read' | 'write';

/**
 * Create, reuse, and revoke app keys — extra agents with their own secret,
 * granted only the resources you pick. The signed-in session stays you.
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

  const { subjects: folderChildren } = useChildren(folderSubject);
  const [minted, setMinted] = useState<string[]>([]);
  const children = useMemo(
    () => [...new Set([...folderChildren, ...minted])],
    [folderChildren, minted],
  );
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
              Each key is its own identity. Grant a workspace, or a single
              folder or page — rights inherit to everything inside.
            </Explanation>
            <Button
              onClick={() => {
                setSecret(undefined);
                showCreate();
              }}
              disabled={!folderSubject}
              data-testid='create-app-key'
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
              onCreated={issued => {
                setMinted(list =>
                  list.includes(issued.subject)
                    ? list
                    : [...list, issued.subject],
                );
                setSecret(issued.secret);
              }}
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
  const recorded =
    (resource.get(dataBrowser.properties.resources) as string[] | undefined) ??
    [];

  const access = useMemo(() => {
    let write = false;
    let read = false;
    const granted: string[] = [];
    const candidates = [...new Set([...recorded, ...workspaces])];

    for (const target of candidates) {
      const res = store.getResourceLoading(target);
      const readers = (res.get(core.properties.read) as string[]) ?? [];
      const writers = (res.get(core.properties.write) as string[]) ?? [];

      if (writers.includes(subject)) {
        write = true;
        read = true;
        granted.push(target);
      } else if (readers.includes(subject)) {
        read = true;
        granted.push(target);
      }
    }

    return { write, read, granted };
    // `aclEpoch` re-reads ACLs after grant/revoke; the store mutates
    // those resources in place so the subject list alone would not refresh.
  }, [store, subject, workspaces, recorded, aclEpoch]);

  async function handleRevoke() {
    setBusy(true);

    try {
      const known = [...new Set([...recorded, ...workspaces])];
      const report = await revokeAccessAgent(store, subject, known);
      setAclEpoch(n => n + 1);

      if (report.failed.length > 0) {
        // Never report a revoke that left access behind as done — the whole
        // point of the button is that the secret stops working.
        toast.error(
          `Still has access to ${report.failed.length} of ${known.length} places — could not revoke: ${report.failed
            .map(f => f.reason)
            .join('; ')}`,
        );
      } else {
        toast.success(
          `Key revoked — checked ${known.length} place${
            known.length === 1 ? '' : 's'
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
              {revoked ? (
                'Revoked — this secret can no longer read what you granted.'
              ) : access.read ? (
                <>
                  {access.write ? 'Read and write' : 'Read'}
                  {' · '}
                  <GrantPlaces subjects={access.granted} />
                </>
              ) : (
                'No access'
              )}
            </KeyMeta>
          </Column>
        </Row>
        {!revoked && (
          <Row gap='0.5rem'>
            <Button subtle onClick={showGrant} disabled={busy}>
              Add access
            </Button>
            <Button
              subtle
              alert
              onClick={() => setConfirmRevoke(true)}
              disabled={busy}
              data-testid='revoke-app-key'
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
            workspaces={workspaces}
            alreadyGranted={access.granted}
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
  onCreated: (issued: { secret: string; subject: string }) => void;
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
      const extras = current.filter(s => !workspaces.includes(s));
      const stillWorkspaces = current.filter(s => workspaces.includes(s));
      const next = [
        ...(stillWorkspaces.length > 0 || extras.length > 0
          ? stillWorkspaces
          : workspaces),
        ...extras,
      ];

      return next.length > 0 ? next : workspaces;
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
      onCreated(issued);
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
                data-testid='app-key-name'
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
            <Legend>Access to</Legend>
            <Hint>
              A folder or page grant covers that resource and everything inside
              it — not the rest of the workspace.
            </Hint>
            <Column gap='0.4rem'>
              {workspaces.map(subject => (
                <TargetCheck
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
              {selected
                .filter(s => !workspaces.includes(s))
                .map(subject => (
                  <TargetCheck
                    key={subject}
                    subject={subject}
                    checked
                    onChange={checked =>
                      setSelected(list =>
                        checked
                          ? [...list, subject]
                          : list.filter(s => s !== subject),
                      )
                    }
                  />
                ))}
              <SearchBox
                placeholder={ADD_TARGET_PLACEHOLDER}
                value={undefined}
                scopes={workspaces}
                hideClearButton
                onChange={next => {
                  if (next && !selected.includes(next)) {
                    setSelected(list => [...list, next]);
                  }
                }}
              />
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
          data-testid='app-key-create-confirm'
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
  workspaces,
  alreadyGranted,
  onDone,
  onCancel,
}: {
  agentSubject: string;
  write: boolean;
  workspaces: string[];
  alreadyGranted: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const store = useStore();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const leftovers = workspaces.filter(w => !alreadyGranted.includes(w));

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
        <h1>Add access</h1>
      </Dialog.Title>
      <Dialog.Content>
        <Column gap='0.75rem'>
          <p>
            Same key, more places. The secret does not change — the app already
            holding it gets the new access.
          </p>
          {leftovers.map(subject => (
            <TargetCheck
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
          {selected
            .filter(s => !leftovers.includes(s))
            .map(subject => (
              <TargetCheck
                key={subject}
                subject={subject}
                checked
                onChange={checked =>
                  setSelected(list =>
                    checked ? list : list.filter(s => s !== subject),
                  )
                }
              />
            ))}
          <SearchBox
            placeholder={ADD_TARGET_PLACEHOLDER}
            value={undefined}
            scopes={workspaces}
            hideClearButton
            onChange={next => {
              if (
                next &&
                !selected.includes(next) &&
                !alreadyGranted.includes(next)
              ) {
                setSelected(list => [...list, next]);
              }
            }}
          />
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
        <Button onClick={onDone} data-testid='app-key-secret-done'>
          I have copied it
        </Button>
      </Dialog.Actions>
    </>
  );
}

function TargetCheck({
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

function GrantPlaces({ subjects }: { subjects: string[] }) {
  if (subjects.length === 0) {
    return <>nothing</>;
  }

  if (subjects.length > 2) {
    return <>{subjects.length} places</>;
  }

  return (
    <>
      {subjects.map((subject, index) => (
        <span key={subject}>
          {index > 0 ? ', ' : ''}
          <TargetName subject={subject} />
        </span>
      ))}
    </>
  );
}

function TargetName({ subject }: { subject: string }) {
  const resource = useResource(subject);
  const [title] = useTitle(resource);

  return <>{title || 'Untitled'}</>;
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

const Hint = styled.p`
  margin: 0 0 0.5rem;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9em;
`;
