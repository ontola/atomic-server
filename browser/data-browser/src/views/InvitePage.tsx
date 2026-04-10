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

import { Button } from '../components/Button';
import { constructOpenURL } from '../helpers/navigation';
import { useSettings } from '../helpers/AppSettings';
import { ResourcePageProps } from './ResourcePage';
import { paths } from '../routes/paths';
import { Column } from '../components/Row';
import { useWelcomeLayoutEffect } from '../hooks/useWelcomeLayoutEffect';
import { Shell, Card, CardTitle, CtaButton } from './getting-started/GettingStartedFlow';
import atomicServerLogoUrl from '../../../../logo.svg?url';

import { useId, useState, type JSX } from 'react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { getResourcesDrive } from '@helpers/getResourcesDrive';
import { fetchPersonalDriveSubject } from '@helpers/personalDrive';
import { saveAgentToIDB } from '@helpers/agentStorage';
import { Dialog, useDialog } from '@components/Dialog';
import { CodeBlock } from '@components/CodeBlock';
import { styled } from 'styled-components';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import Field from '@components/forms/Field';

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
    requestAnimationFrame(() => {
      navigate(constructOpenURL(url));
      void store.fetchResourceFromServer(url).finally(() => {
        const signedIn = store.getAgent();

        if (!signedIn?.subject) {
          return;
        }

        void fetchPersonalDriveSubject(store, signedIn).then(home => {
          if (home) {
            setDrive(home);
          }
        });
      });
    });
  };

  /** Persist agent after invite: personal drive, host drive bookmark, sharedWithMe. */
  const persistAgentAfterInvite = async (
    subject: string,
    destination: string | undefined,
    name?: string,
  ) => {
    const resourceToSave = store.getResourceLoading(subject);

    try {
      if (name?.trim()) {
        await resourceToSave.set(core.properties.name, name.trim());
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
          await store.fetchResourceFromServer(destination);
          const target = store.getResourceLoading(destination);
          const hostDrive = await getResourcesDrive(target, store);

          if (hostDrive) {
            resourceToSave.push(server.properties.drives, [hostDrive], true);
          }

          const existingPersonal = resourceToSave.get(
            core.properties.personalDrive,
          ) as string | undefined;

          if (!existingPersonal) {
            const driveLabel = name?.trim()
              ? `${name.trim()}'s Drive`
              : 'Personal';
            const pd = await store.newResource({
              isA: server.classes.drive,
              noParent: true,
              propVals: {
                [core.properties.name]: driveLabel,
                [core.properties.description]:
                  'Your private space on this server. Only you can read and write here.',
                [core.properties.write]: [subject],
                [core.properties.read]: [subject],
              },
            });

            await pd.save();
            await resourceToSave.set(core.properties.personalDrive, pd.subject);
            resourceToSave.push(server.properties.drives, [pd.subject], true);
          }

          resourceToSave.push(
            core.properties.sharedWithMe,
            [destination],
            true,
          );
        } catch (e) {
          store.notifyError(
            e instanceof Error
              ? e
              : new Error('Failed to update agent after invite'),
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

      await persistAgentAfterInvite(agentSubject, redirectURL, agentName);
      goToRedirect();
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

      const subject = `did:ad:agent:${keypair.publicKey}`;
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
      const newAgentSubject = `did:ad:agent:${keys.real.publicKey}`;
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
      setIsNewAgent(false);
      setRedirectURL(destination);
      void (async () => {
        await persistAgentAfterInvite(agentSubject!, destination, undefined);
        goToRedirect(destination);
      })();

      return;
    }

    // New agent: show dialog (secret, name) then on Continue we persist and redirect
    setRedirectURL(destination);
    show();
  };

  const agentSubject = agent?.subject;

  useWelcomeLayoutEffect();

  // Extract the resource name from the server-generated description
  // Format: "Stateless invite to edit/view the resource: ResourceName"
  const resourceName = description?.split(': ').pop();

  return (
    <>
      <Shell>
        <Card>
          <LogoWrap>
            <img src={atomicServerLogoUrl} alt='AtomicServer' width={180} />
          </LogoWrap>
          <CardTitle>
            You've been invited to {write ? 'edit' : 'view'}
            {resourceName ? ` "${resourceName}"` : ''}
          </CardTitle>
          {usagesLeft === 0 ? (
            <DescriptionWrap>
              Sorry, this invite has no usages left. Ask for a new one.
            </DescriptionWrap>
          ) : (
            <Column gap='0.75rem'>
              {agentSubject ? (
                <CtaButton
                  data-test='accept-existing'
                  onClick={() => handleAccept()}
                >
                  Accept as {agentTitle}
                </CtaButton>
              ) : (
                <>
                  <CtaButton data-test='accept-new' onClick={handleNew}>
                    Create account and accept
                  </CtaButton>
                  <CtaButton
                    data-test='accept-sign-in'
                    onClick={() => navigate(paths.agentSettings)}
                    subtle
                  >
                    I already have an account
                  </CtaButton>
                </>
              )}
            </Column>
          )}
        </Card>
      </Shell>
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

const LogoWrap = styled.div`
  text-align: center;
  margin-bottom: ${p => p.theme.size(4)};
`;

const DescriptionWrap = styled.div`
  color: ${p => p.theme.colors.textLight};
  text-align: center;
  margin-bottom: ${p => p.theme.size(5)};
`;

const StyledCodeBlock = styled(CodeBlock)`
  word-break: break-word;

  & button {
    top: ${p => p.theme.size(1)};
    right: ${p => p.theme.size(1)};
  }
`;
