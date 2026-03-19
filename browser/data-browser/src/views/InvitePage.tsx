import {
  useBoolean,
  useNumber,
  useResource,
  useTitle,
  useString,
  Agent,
  generateKeyPair,
  server,
  core,
  useStore,
  type Server,
  SubtleCryptoProvider,
  JSCryptoProvider,
  type KeyPair,
  Resource,
} from '@tomic/react';

import { ContainerNarrow } from '../components/Containers';
import { Button } from '../components/Button';
import { constructOpenURL } from '../helpers/navigation';
import { useSettings } from '../helpers/AppSettings';
import { ResourcePageProps } from './ResourcePage';
import { paths } from '../routes/paths';
import { Row } from '../components/Row';

import { useId, useState, type JSX } from 'react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { getResourcesDrive } from '@helpers/getResourcesDrive';
import { saveAgentToIDB } from '@helpers/agentStorage';
import { Dialog, useDialog } from '@components/Dialog';
import { CodeBlock } from '@components/CodeBlock';
import { styled } from 'styled-components';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import Field from '@components/forms/Field';
import Markdown from 'react-markdown';

/** A View that opens an invite */
function InvitePage({ resource }: ResourcePageProps): JSX.Element {
  const nameInputId = useId();
  const store = useStore();
  const [usagesLeft] = useNumber(resource, server.properties.usagesLeft);
  const [write] = useBoolean(resource, server.properties.write);
  const [description] = useString(resource, core.properties.description);
  const navigate = useNavigateWithTransition();
  const { agent, setAgent, setDrive } = useSettings();
  const agentResource = useResource(agent?.subject);
  const [agentTitle] = useTitle(agentResource, 15);
  const [redirectURL, setRedirectURL] = useState<string | undefined>(undefined);
  const [agentSecret, setAgentSecret] = useState<string | undefined>();
  const [agentName, setAgentName] = useState<string | undefined>(undefined);
  const [hasCopiedSecret, setHasCopiedSecret] = useState(false);
  const [isNewAgent, setIsNewAgent] = useState(false);

  const getRedirectDestination = async (
    redirect: Resource<Server.Redirect>,
  ): Promise<string | undefined> => {
    const destinationValue = (await redirect.get(
      server.properties.destination,
    )) as unknown;
    const redirectProps = redirect.props as Record<string, unknown>;

    return (
      (typeof destinationValue === 'string' ? destinationValue : undefined) ??
      (redirectProps[server.properties.destination] as string | undefined) ??
      (redirectProps.destination as string | undefined)
    );
  };

  const goToRedirect = (destination?: string) => {
    const url = destination ?? redirectURL;
    if (!url) return;
    // React needs a cycle to update the agent so we defer navigation.
    requestAnimationFrame(() => {
      navigate(constructOpenURL(url));
      // Best-effort prefetch to set the active drive; navigation should not depend on this.
      store
        .fetchResourceFromServer(url)
        .then((target: Resource) => {
          getResourcesDrive(target, store)
            .then(setDrive)
            .catch(() => undefined);
        })
        .catch(() => undefined);
    });
  };

  /** Persist agent (isA, name, drives) to the server. Used after accepting an invite for both new and existing agents. */
  const persistAgentAfterInvite = async (
    subject: string,
    destination: string | undefined,
    name?: string,
  ) => {
    const resourceToSave = store.getResourceLoading(subject);

    try {
      if (name?.trim()) {
        await resourceToSave.set(core.properties.name, name);
      }

      const currentIsA =
        (await resourceToSave.get(core.properties.isA)) ?? ([] as string[]);

      if (!currentIsA.includes(core.classes.agent)) {
        await resourceToSave.set(core.properties.isA, [
          ...currentIsA,
          core.classes.agent,
        ]);
      }

      if (destination) {
        try {
          const target = await store.fetchResourceFromServer(destination);
          const driveSubject = await getResourcesDrive(target, store);

          if (driveSubject) {
            resourceToSave.push(server.properties.drives, [driveSubject]);
          }
        } catch (e) {
          store.notifyError(
            e instanceof Error
              ? e
              : new Error('Failed to add invited drive to agent'),
          );
        }
      }

      await resourceToSave.save();
    } catch (e) {
      store.notifyError(
        e instanceof Error
          ? e
          : new Error('Failed to persist agent after accepting invite'),
      );
    }
  };

  const [dialogProps, show, hide] = useDialog({
    onSuccess: async () => {
      setAgentSecret(undefined);
      const agentSubject = agent?.subject;

      if (!agentSubject) {
        goToRedirect();

        return;
      }

      goToRedirect();
      void persistAgentAfterInvite(agentSubject, redirectURL, agentName);
    },
  });

  // When the Invite is accepted, a new Agent might be created client-side.
  async function handleNew() {
    try {
      const keypair = await generateKeyPair();

      let cryptoKeyPair: CryptoKeyPair | undefined;

      try {
        cryptoKeyPair =
          await SubtleCryptoProvider.createKeysFromKeyPair(keypair);
      } catch {
        // SubtleCrypto doesn't support Ed25519 in this environment.
        // We'll use JSCryptoProvider as a fallback below.
      }

      const provider = cryptoKeyPair
        ? new SubtleCryptoProvider(cryptoKeyPair)
        : new JSCryptoProvider(keypair.privateKey);

      const subject = `did:ad:${keypair.publicKey}`;
      const newAgent = new Agent(provider, subject);

      store.setAgent(newAgent);

      // Create the initial Agent resource using the Store instance,
      // otherwise it won't have a store bound (and `.save()` will fail).
      const newAgentResource = store.getResourceLoading(subject, {
        newResource: true,
      });
      await newAgentResource.set(core.properties.publicKey, keypair.publicKey);
      await newAgentResource.set(core.properties.isA, [core.classes.agent]);
      await newAgentResource.save();

      setAgent(newAgent);
      handleAccept({ crypto: cryptoKeyPair, real: keypair });
    } catch (error) {
      store.notifyError(error);
    }
  }

  const handleAccept = async (keys?: {
    crypto?: CryptoKeyPair;
    real: KeyPair;
  }) => {
    const inviteURL = new URL(resource.subject);
    const redirect = await store.postToServer<Server.Redirect>(inviteURL.href);

    if (redirect.error) {
      store.notifyError(redirect.error);

      return;
    }

    const destination = await getRedirectDestination(redirect);

    if (!destination) {
      store.notifyError(
        new Error('Invite accepted, but no destination was returned.'),
      );

      return;
    }

    if (keys) {
      const newAgentSubject = `did:ad:${keys.real.publicKey}`;
      const secret = Agent.buildSecret(
        keys.real.privateKey,
        newAgentSubject,
        destination,
      );

      const provider = keys.crypto
        ? new SubtleCryptoProvider(keys.crypto)
        : new JSCryptoProvider(keys.real.privateKey);
      const newAgent = new Agent(provider, newAgentSubject, destination);

      if (keys.crypto) {
        saveAgentToIDB(keys.crypto, newAgentSubject);
      }

      setAgentSecret(secret);
      setAgent(newAgent);
      setIsNewAgent(true);
    } else {
      // Existing agent: persist agent (isA, drives) and redirect immediately — no dialog
      setIsNewAgent(false);
      setRedirectURL(destination);
      goToRedirect(destination);
      void persistAgentAfterInvite(agentSubject!, destination, undefined);

      return;
    }

    // New agent: show dialog (secret, name) then on Continue we persist and redirect
    setRedirectURL(destination);
    show();
  };

  const agentSubject = agent?.subject;

  return (
    <>
      <ContainerNarrow>
        <h1>Invite to {write ? 'edit' : 'view'}</h1>
        {description && <Markdown>{description}</Markdown>}
        {usagesLeft === 0 ? (
          <em>Sorry, this Invite has no usages left. Ask for a new one.</em>
        ) : (
          <Row>
            {agentSubject ? (
              <>
                <Button
                  data-test='accept-existing'
                  onClick={() => handleAccept()}
                >
                  Accept as {agentTitle}
                </Button>
              </>
            ) : (
              <>
                <Button data-test='accept-new' onClick={handleNew}>
                  Accept as new user
                </Button>
                <Button
                  data-test='accept-sign-in'
                  onClick={() => navigate(paths.agentSettings)}
                  subtle
                >
                  Sign in
                </Button>
              </>
            )}
            {usagesLeft !== undefined && <p>({usagesLeft} usages left)</p>}
          </Row>
        )}
      </ContainerNarrow>
      <Dialog {...dialogProps} disableLightDismiss>
        <Dialog.Title>
          <h1>Agent created!</h1>
        </Dialog.Title>
        <Dialog.Content>
          <Field label='Agent Name' fieldId={nameInputId}>
            <InputWrapper>
              <InputStyled
                type='text'
                value={agentName}
                onChange={e => setAgentName(e.target.value)}
                id={nameInputId}
                spellCheck='false'
                placeholder='Enter a name'
              />
            </InputWrapper>
          </Field>
          {isNewAgent && agentSecret && (
            <Field label='Agent Secret'>
              <p>
                IMPORTANT! Below is your agent secret, you use this to login.
                Save it somewhere safe, the secret will not be show again and if
                you lose it you will not be able to access this user again.
              </p>
              <StyledCodeBlock
                wordWrap
                content={agentSecret}
                onCopy={() => setHasCopiedSecret(true)}
              />
            </Field>
          )}
        </Dialog.Content>
        <Dialog.Actions>
          <Button
            onClick={() => hide(true)}
            disabled={isNewAgent && !hasCopiedSecret}
          >
            {isNewAgent
              ? hasCopiedSecret
                ? 'Continue'
                : 'Copy secret to continue'
              : 'Continue'}
          </Button>
        </Dialog.Actions>
      </Dialog>
    </>
  );
}

export default InvitePage;

const StyledCodeBlock = styled(CodeBlock)`
  word-break: break-word;

  & button {
    top: ${p => p.theme.size(1)};
    right: ${p => p.theme.size(1)};
  }
`;
