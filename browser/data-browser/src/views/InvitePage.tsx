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
} from '@tomic/react';

import { ContainerNarrow } from '../components/Containers';
import { ValueForm } from '../components/forms/ValueForm';
import { Button } from '../components/Button';
import { constructOpenURL } from '../helpers/navigation';
import { useSettings } from '../helpers/AppSettings';
import { ResourcePageProps } from './ResourcePage';
import { paths } from '../routes/paths';
import { Row } from '../components/Row';

import type { JSX } from 'react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { useNavState } from '../components/NavState';
import { toast } from 'react-hot-toast';

/** A View that opens an invite */
function InvitePage({ resource }: ResourcePageProps): JSX.Element {
  const store = useStore();
  const [usagesLeft] = useNumber(resource, server.properties.usagesLeft);
  const [write] = useBoolean(resource, server.properties.write);
  const navigate = useNavigateWithTransition();
  const navigationType = useNavState();
  const { agent, setAgent } = useSettings();
  const agentResource = useResource(agent?.subject);
  const [agentTitle] = useTitle(agentResource, 15);

  // When the Invite is accepted, a new Agent might be created.
  // When this happens, a new keypair is made, but the subject of the Agent is not yet known.
  // It will be created by the server, and will be accessible in the Redirect response.
  async function handleNew() {
    const keypair = await generateKeyPair();
    const newAgent = new Agent(keypair.privateKey);

    setAgent(newAgent);
    handleAccept(keypair);
  }

  const handleAccept = async (keys?: {
    publicKey: string;
    privateKey: string;
  }) => {
    const inviteURL = new URL(resource.subject);

    if (keys) {
      inviteURL.searchParams.set('public-key', keys.publicKey);
    } else {
      inviteURL.searchParams.set('agent', agentSubject!);
    }

    const redirect = await store.getResource<Server.Redirect>(inviteURL.href);

    if (redirect.props.redirectAgent && keys) {
      const newAgent = new Agent(keys.privateKey, redirect.props.redirectAgent);
      setAgent(newAgent);

      showAgentCreatedToast();
    }

    // Go to the destination, unless the user just hit the back button
    if (redirect.props.destination) {
      // React needs a cycle to update the agent so we defer the next bit of code to after the render cycle so the store has the updated agent.
      // If we don't do this the store would refetch the resource with the old agent that does not have access to the resource.
      requestAnimationFrame(() => {
        // Refetch the resource now that we have read access.
        store
          .fetchResourceFromServer(redirect.props.destination)
          .then(() => {
            navigate(constructOpenURL(redirect.props.destination));
          })
          .catch(err => {
            console.error(err);
          });
      });
    }
  };

  const showAgentCreatedToast = () => {
    toast.success(
      <div>
        <p>New User created!</p>
        <Button onClick={() => navigate(paths.agentSettings)}>
          User Settings
        </Button>
      </div>,
      { duration: 6000 },
    );
  };

  const agentSubject = agent?.subject;

  if (agentSubject && usagesLeft && usagesLeft > 0) {
    // Accept the invite if an agent subject is present, but not if the user just pressed the back button
    if (navigationType !== 'POP') {
      handleAccept();
    }
  }

  return (
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
  );
}

export default InvitePage;
