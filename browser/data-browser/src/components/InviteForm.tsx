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
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ErrorLook } from './ErrorLook';
import { Button } from './Button';
import { CodeBlock } from './CodeBlock';
import ResourceField from './forms/ResourceField';
import { useOwnNodeDid } from '../hooks/useOwnNodeDid';
import { fetchManagedInfo } from '../helpers/managedServer';
import { isValidNodeDid } from '../helpers/serverOntology';

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
  const ownNodeDid = useOwnNodeDid();
  const [serverNodeDid, setServerNodeDid] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    const origin = store.getServerUrl();

    if (!origin) {
      return;
    }

    fetchManagedInfo(origin)
      .then(info => {
        if (!cancelled && info.nodeId && isValidNodeDid(info.nodeId)) {
          setServerNodeDid(info.nodeId);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [store]);

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

      const baseUrl = store.getServerUrl().replace(/\/$/, '');
      const node = ownNodeDid ?? serverNodeDid;
      // Invite redeem stays on the server path; attach resolve hints so a
      // recipient who later opens the target DID can find this node.
      const params = new URLSearchParams();
      params.set('token', tokenBase64);

      if (agent.subject) {
        params.set('agent', agent.subject);
      }

      if (node) {
        params.set('node', node);
      }

      const finalUrl = `${baseUrl}/app/invite?${params.toString()}`;

      setInviteUrl(finalUrl);
      setSaved(true);
      navigator.clipboard.writeText(finalUrl);
      toast.success(
        node || agent.subject
          ? 'Invite copied (includes resolve hints)'
          : 'Copied to clipboard',
      );
    } catch (e) {
      setErr(e);
    }
  }, [invite, agent, target, store, ownNodeDid, serverNodeDid]);

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
  }

  return (
    <>
      <p>Invite created and copied to clipboard! 🚀</p>
      <CodeBlock content={inviteUrl!} data-test='invite-code' />
    </>
  );
}
