import {
  useBoolean,
  useNumber,
  useResource,
  useTitle,
  Agent,
  generateKeyPair,
  server,
  core,
  useStore,
  type Server,
  SubtleCryptoProvider,
  type KeyPair,
} from '@tomic/react';

import { ContainerNarrow } from '../components/Containers';
import { ValueForm } from '../components/forms/ValueForm';
import { Button } from '../components/Button';
import { constructOpenURL } from '../helpers/navigation';
import { useSettings } from '../helpers/AppSettings';
import { ResourcePageProps } from './ResourcePage';
import { paths } from '../routes/paths';
import { Row } from '../components/Row';

import { useId, useState, type JSX } from 'react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { useNavState } from '../components/NavState';
import { getResourcesDrive } from '@helpers/getResourcesDrive';
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
  const navigate = useNavigateWithTransition();
  const navigationType = useNavState();
  const { agent, setAgent, setDrive } = useSettings();
  const agentResource = useResource(agent?.subject);
  const [agentTitle] = useTitle(agentResource, 15);
  const [redirectURL, setRedirectURL] = useState<string | undefined>(undefined);
  const [agentSecret, setAgentSecret] = useState<string | undefined>();
  const [agentName, setAgentName] = useState<string | undefined>(undefined);
  const [hasCopiedSecret, setHasCopiedSecret] = useState(false);

  const goToRedirect = () => {
    if (!redirectURL) return;
    // React needs a cycle to update the agent so we defer the next bit of code to after the render cycle so the store has the updated agent.
    // If we don't do this the store would refetch the resource with the old agent that does not have access to the resource.
    requestAnimationFrame(() => {
      // Refetch the resource now that we have read access.
      store
        .fetchResourceFromServer(redirectURL)
        .then(target => {
          // Try to set the current drive to the drive containing the target resource.
          // Then navigate to the target resource.
          getResourcesDrive(target, store)
            .then(setDrive)
            .finally(() => {
              navigate(constructOpenURL(redirectURL));
            });
        })
        .catch(err => {
          console.error(err);
        });
    });
  };

  const [dialogProps, show, hide] = useDialog({
    onSuccess: async () => {
      setAgentSecret(undefined);

      if (agentName) {
        await agentResource.set(core.properties.name, agentName);
        await agentResource.save();
      }

      goToRedirect();
    },
  });

  // When the Invite is accepted, a new Agent might be created.
  // When this happens, a new keypair is made, but the subject of the Agent is not yet known.
  // It will be created by the server, and will be accessible in the Redirect response.
  async function handleNew() {
    try {
      const keypair = await generateKeyPair();
      const cryptoKeyPair =
        await SubtleCryptoProvider.createKeysFromKeyPair(keypair);

      const provider = new SubtleCryptoProvider(cryptoKeyPair);
      const newAgent = new Agent(provider);

      setAgent(newAgent);
      handleAccept({ crypto: cryptoKeyPair, real: keypair });
    } catch (error) {
      store.notifyError(error);
    }
  }

  const handleAccept = async (keys?: {
    crypto: CryptoKeyPair;
    real: KeyPair;
  }) => {
    const inviteURL = new URL(resource.subject);

    if (keys) {
      inviteURL.searchParams.set('public-key', keys.real.publicKey);
    } else {
      inviteURL.searchParams.set('agent', agentSubject!);
    }

    const redirect = await store.getResource<Server.Redirect>(inviteURL.href);
    const redirectAgent = redirect.props.redirectAgent;

    if (keys && redirectAgent) {
      if (redirect.error) {
        store.notifyError(redirect.error);

        return;
      }

      const secret = Agent.buildSecret(keys.real.privateKey, redirectAgent);

      const newAgent = new Agent(
        new SubtleCryptoProvider(keys.crypto),
        redirect.props.redirectAgent,
      );

      saveAgentToIDB(keys.crypto, redirectAgent);
      setAgentSecret(secret);
      setAgent(newAgent);
    }

    // Go to the destination, unless the user just hit the back button
    if (redirect.props.destination) {
      setRedirectURL(redirect.props.destination);
      show();
    }
  };

  const agentSubject = agent?.subject;

  if (agentSubject && usagesLeft && usagesLeft > 0) {
    // Accept the invite if an agent subject is present, but not if the user just pressed the back button
    if (navigationType !== 'POP') {
      handleAccept();
    }
  }

  return (
    <>
      <ContainerNarrow>
        <h1>Invite to {write ? 'edit' : 'view'}</h1>
        <ValueForm
          resource={resource}
          propertyURL={core.properties.description}
        />
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
          <Field label='Agent Secret'>
            <p>
              IMPORTANT! Below is your agent secret, you use this to login. Save
              it somewhere safe, the secret will not be show again and if you
              lose it you will not be able to access this user again.
            </p>
            <StyledCodeBlock
              wordWrap
              content={agentSecret}
              onCopy={() => setHasCopiedSecret(true)}
            />
          </Field>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onClick={() => hide(true)} disabled={!hasCopiedSecret}>
            {hasCopiedSecret ? 'Continue' : 'Copy secret to continue'}
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
