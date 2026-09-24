import { TeamProfileStep } from './TeamProfileStep';
import {
  useResource,
  useResourceSnapshot,
  useString,
  useStore,
  Resource,
  urls,
  useCurrentAgent,
  server,
  dataBrowser,
} from '@tomic/react';
import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { managedFetch } from '../helpers/managed/api';
import { useCreateInviteLink } from './Share/useCreateInviteLink';
import { getManagedPortalUrl } from '../helpers/managed/cloudSync';
import toast from 'react-hot-toast';
import { ErrorLook } from './ErrorLook';
import { Button } from './Button';
import { Column, Row } from './Row';
import { CodeBlock } from './CodeBlock';
import ResourceField from './forms/ResourceField';

interface InviteFormProps {
  /** The resource that becomes accessible on opening the invite */
  target: Resource;
  inDialog?: boolean;
  /** Shown above the form, e.g. a warning about what is being shared */
  notice?: ReactNode;
  /** Rendered next to the Create button */
  secondaryAction?: ReactNode;
}

/**
 * Allows the user to create a new Invite for some resource. Outputs the
 * generated Subject after saving.
 */
export function InviteForm({
  target,
  inDialog,
  notice,
  secondaryAction,
}: InviteFormProps) {
  const [agent] = useCurrentAgent();
  const {
    resource: profile,
    ready,
    error,
  } = useResourceSnapshot(agent?.subject);
  const [icon] = useString(profile, dataBrowser.properties.icon);

  if (agent?.subject && error) {
    return <ErrorLook>{error.message}</ErrorLook>;
  }

  if (agent?.subject && !ready) return null;

  return (
    <InviteFormContent
      key={agent?.subject}
      target={target}
      inDialog={inDialog}
      notice={notice}
      secondaryAction={secondaryAction}
      skipProfile={!!icon || profileReviewedBefore(agent?.subject)}
    />
  );
}

function InviteFormContent({
  target,
  skipProfile,
  inDialog,
  notice,
  secondaryAction,
}: InviteFormProps & { skipProfile: boolean }) {
  const store = useStore();
  const [subject] = useState(() => store.createSubject());
  const invite = useResource(subject, {
    newResource: true,
  });
  const isSaas = !!getManagedPortalUrl();
  const [err, setErr] = useState<Error | undefined>(undefined);
  const [agent] = useCurrentAgent();
  const createInviteLink = useCreateInviteLink(target);
  const [profileReviewed, setProfileReviewed] = useState(skipProfile);
  const [saved, setSaved] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | undefined>(undefined);

  const [creating, setCreating] = useState(false);
  const [seats, setSeats] = useState<{
    drive: string;
    used?: number;
    included?: number;
  }>();

  useEffect(() => {
    setSeats(undefined);
    if (!isSaas) return;
    const controller = new AbortController();
    const drive = target.hasClasses(server.classes.drive)
      ? target.subject
      : store.getDrive();
    if (!drive) return;
    void managedFetch(
      `/billing/subscription?${new URLSearchParams({ drive })}`,
      {
        signal: controller.signal,
      },
    )
      .then(async response => {
        if (!response.ok || response.status === 204) return;
        const subscription = await response.json();
        if (
          controller.signal.aborted ||
          subscription.plan !== 'server' ||
          subscription.status === 'canceled'
        )
          return;
        setSeats({
          drive,
          used: subscription.editors_used,
          included: subscription.editors_included,
        });
      })
      .catch(() => {
        /* Do not imply hosting when billing is unavailable. */
      });

    return () => controller.abort();
  }, [isSaas, target, store]);

  /** Generates the signed token and constructs the invite URL */
  const createInvite = async () => {
    setCreating(true);
    setErr(undefined);

    try {
      const write = (await invite.get(server.properties.write)) as boolean;
      const expiresAt = (await invite.get(
        urls.properties.invite.expiresAt,
      )) as number;
      const finalUrl = await createInviteLink({ write: !!write, expiresAt });

      setInviteUrl(finalUrl);
      setSaved(true);
      navigator.clipboard.writeText(finalUrl);
      toast.success('Copied to clipboard');
    } catch (e) {
      setErr(e);
    } finally {
      setCreating(false);
    }
  };

  if (agent?.subject && !profileReviewed) {
    const agentSubject = agent.subject;

    return (
      <InviteFormLayout inDialog={inDialog}>
        <TeamProfileStep
          subject={agentSubject}
          onContinue={() => {
            rememberProfileReviewed(agentSubject);
            setProfileReviewed(true);
          }}
        />
      </InviteFormLayout>
    );
  }

  if (!saved) {
    return (
      <InviteFormLayout
        inDialog={inDialog}
        actions={
          <>
            {secondaryAction}
            <Button disabled={creating} onClick={createInvite}>
              {creating ? 'Preparing invite…' : 'Create'}
            </Button>
          </>
        }
      >
        <Column gap='1rem'>
          {notice}
          <ResourceField
            label={'Allow edits'}
            propertyURL={server.properties.write}
            resource={invite}
          />
          {seats &&
            seats.drive ===
              (target.hasClasses(server.classes.drive)
                ? target.subject
                : store.getDrive()) && (
              <p>
                {Number.isSafeInteger(seats.used) &&
                Number.isSafeInteger(seats.included)
                  ? `${Math.max(0, seats.included! - seats.used!)} of ${seats.included} editor seats available on this drive.`
                  : 'Editor seat availability for this drive is unavailable.'}{' '}
                Viewers are free.
              </p>
            )}
          {err && (
            <p>
              <ErrorLook>{err.message}</ErrorLook>
            </p>
          )}
        </Column>
      </InviteFormLayout>
    );
  } else
    return (
      <InviteFormLayout inDialog={inDialog}>
        <p>Invite created and copied to clipboard! 🚀</p>
        <CodeBlock content={inviteUrl!} data-test='invite-code' />
      </InviteFormLayout>
    );
}

const PROFILE_REVIEWED_KEY = 'inviteProfileReviewed';

/**
 * Share opens on the invite, so without this someone who skips the optional
 * picture would get the profile step on every Share click. Once per agent on
 * this device is enough of a nudge.
 */
export function profileReviewedBefore(agent: string | undefined): boolean {
  if (!agent) return false;

  try {
    return localStorage.getItem(PROFILE_REVIEWED_KEY) === agent;
  } catch {
    return false;
  }
}

export function rememberProfileReviewed(agent: string): void {
  try {
    localStorage.setItem(PROFILE_REVIEWED_KEY, agent);
  } catch {
    /* Without storage the step simply shows again next time. */
  }
}

function InviteFormLayout({
  inDialog,
  children,
  actions,
}: {
  inDialog?: boolean;
  children: ReactNode;
  actions?: ReactNode;
}) {
  if (inDialog) {
    return (
      <>
        <Dialog.Content>{children}</Dialog.Content>
        {actions && <Dialog.Actions>{actions}</Dialog.Actions>}
      </>
    );
  }

  return (
    <Column gap='1rem'>
      {children}
      {actions && <Row>{actions}</Row>}
    </Column>
  );
}
