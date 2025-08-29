import {
  useResource,
  useStore,
  Resource,
  urls,
  useCurrentAgent,
  core,
  server,
} from '@tomic/react';
import { generateInviteToken } from '@tomic/lib';
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import { ErrorLook } from './ErrorLook';
import { Button } from './Button';
import { CodeBlock } from './CodeBlock';
import ResourceField from './forms/ResourceField';

interface InviteFormProps {
  /** The resource that becomes accessible on opening the invite */
  target: Resource;
}

/**
 * Allows the user to create a new Invite for some resource. Outputs the
 * generated Subject after saving.
 */
export function InviteForm({ target }: InviteFormProps) {
  const store = useStore();
  const [subject] = useState(() => store.createSubject());
  const invite = useResource(subject, {
    newResource: true,
  });
  const [err, setErr] = useState<Error | undefined>(undefined);
  const [agent] = useCurrentAgent();
  const [saved, setSaved] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | undefined>(undefined);

  /** Generates the signed token and constructs the invite URL */
  const createInvite = useCallback(async () => {
    try {
      if (!agent) {
        throw new Error('No agent found');
      }

      const write = (await invite.get(server.properties.write)) as boolean;
      const expiresAt = (await invite.get(
        urls.properties.invite.expiresAt,
      )) as number;

      const tokenBase64 = await generateInviteToken(
        target.subject,
        agent,
        !!write,
        expiresAt,
      );

      const baseUrl = store.getServerUrl();
      const finalUrl = `${baseUrl}/invites?token=${encodeURIComponent(
        tokenBase64,
      )}`;

      setInviteUrl(finalUrl);
      setSaved(true);
      navigator.clipboard.writeText(finalUrl);
      toast.success('Copied to clipboard');
    } catch (e) {
      setErr(e);
    }
  }, [invite, agent, target, store]);

  if (!saved) {
    return (
      <>
        <ResourceField
          label={'Allow edits'}
          propertyURL={server.properties.write}
          resource={invite}
        />
        <ResourceField
          label={'Invite text (optional)'}
          propertyURL={core.properties.description}
          resource={invite}
        />
        <ResourceField
          label={'Limit Usages (optional)'}
          propertyURL={server.properties.usagesLeft}
          resource={invite}
        />
        <Button onClick={createInvite}>Create</Button>
        {err && (
          <p>
            <ErrorLook>{err.message}</ErrorLook>
          </p>
        )}
      </>
    );
  } else
    return (
      <>
        <p>Invite created and copied to clipboard! 🚀</p>
        <CodeBlock content={inviteUrl!} data-test='invite-code' />
      </>
    );
}
