import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { FaPlug } from 'react-icons/fa6';
import {
  useChildren,
  useNumber,
  useResource,
  useStore,
  useString,
} from '@tomic/react';
import { Button } from '@components/Button';
import { appAgentOf } from '@chunks/AppPage/appAgent';
import { ConnectDialog } from '@chunks/AppPage/ConnectDialog';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import {
  ProxyConnections,
  type ProxyConnection,
} from '@helpers/proxyConnections';
import { toRelativeDateTime } from '@helpers/dates/relativeDate';

// @wc-ignore-start
const CONNECTION_REQUEST = 'https://atomicdata.dev/classes/ConnectionRequest';
const PLATFORM = 'https://atomicdata.dev/properties/connectionPlatform';
const REASON = 'https://atomicdata.dev/properties/connectionReason';
const REQUESTED_BY = 'https://atomicdata.dev/properties/connectionRequestedBy';
const SINCE = 'https://atomicdata.dev/properties/connectionSince';
/** Set on the way back from the proxy, so the page can finish clearing. */
const RETURN_PARAM = 'connected-request';
// @wc-ignore-end

/** `google-calendar` -> `Google Calendar`. */
export function platformName(id: string): string {
  return id
    .split('-')
    .map(word => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ');
}

const proxy = (store: ReturnType<typeof useStore>) =>
  new ProxyConnections(localStorage, getIntegrationProxy(), () =>
    store.getAgent(),
  );

/**
 * What a node asked for while nobody was here.
 *
 * A scheduled run that needs a platform its installation is not connected to
 * cannot ask anyone, so the node leaves a `ConnectionRequest` under the
 * installation (ontola/atomic-server#2162). Connecting, or choosing a
 * connection the person already has, delegates it to the installation's app
 * agent and destroys the request. The node sees that through sync and starts
 * running the schedule again.
 */
export function ConnectionRequests({
  installation,
  drive,
  title,
}: {
  installation: string;
  drive: string;
  title: string;
}): React.JSX.Element | null {
  const { subjects } = useChildren(installation);

  return (
    <>
      {subjects.map(subject => (
        <RequestNotice
          key={subject}
          subject={subject}
          installation={installation}
          drive={drive}
          title={title}
        />
      ))}
    </>
  );
}

function RequestNotice({
  subject,
  installation,
  drive,
  title,
}: {
  subject: string;
  installation: string;
  drive: string;
  title: string;
}): React.JSX.Element | null {
  const store = useStore();
  const request = useResource(subject);
  const [platform] = useString(request, PLATFORM);
  const [reason] = useString(request, REASON);
  const [node] = useString(request, REQUESTED_BY);
  const [since] = useNumber(request, SINCE);
  const [asking, setAsking] = useState(false);
  const [existing, setExisting] = useState<ProxyConnection[]>();
  const isRequest = request.hasClasses(CONNECTION_REQUEST);

  // Back from the proxy: finish only if the platform really is delegated now.
  useEffect(() => {
    const done = new URLSearchParams(location.search).get(RETURN_PARAM);

    if (!isRequest || !platform || done !== subject) return;

    const url = new URL(location.href);
    url.searchParams.delete(RETURN_PARAM);
    history.replaceState(history.state, '', url);

    appAgentOf(store, { drive, app: installation })
      .then(agent => proxy(store).delegated(agent, platform))
      .then(found => (found.length > 0 ? request.destroy() : undefined))
      .catch(e => toast.error(String(e instanceof Error ? e.message : e)));
  }, [isRequest, platform, subject, store, drive, installation, request]);

  if (!isRequest || !platform) return null;

  const name = platformName(platform);

  const open = () => {
    setAsking(true);
    setExisting(undefined);
    proxy(store)
      .list(platform)
      .then(setExisting)
      .catch(() => setExisting([]));
  };

  const connect = async () => {
    const appAgent = await appAgentOf(store, { drive, app: installation });
    const back = new URL(location.href);
    back.searchParams.set(RETURN_PARAM, subject);
    const url = await proxy(store).start(
      { drive, app: installation, appAgent },
      platform,
      back.href,
      title,
    );

    location.assign(url);
  };

  const useExisting = async (connection: ProxyConnection) => {
    const appAgent = await appAgentOf(store, { drive, app: installation });
    await proxy(store).delegate(connection.connection_id, appAgent, title);
    await request.destroy();
  };

  return (
    <Notice role='status' data-testid='connection-request'>
      <FaPlug aria-hidden />
      <Text>
        <strong>
          {node
            ? `${title} on ${node} needs ${name}`
            : `${title} needs ${name}`}
        </strong>
        <span>{reasonText(reason)}</span>
        {since ? (
          <span>{`Asked ${toRelativeDateTime(new Date(since), true)}.`}</span>
        ) : null}
        <span>Its scheduled runs are paused until you connect it.</span>
      </Text>
      <Button onClick={open}>Connect</Button>
      {asking && (
        <ConnectDialog
          app={title}
          platform={name}
          proxySite={new URL(getIntegrationProxy()).host}
          existing={existing}
          onConnect={connect}
          onUseExisting={useExisting}
          onClosed={() => setAsking(false)}
        />
      )}
    </Notice>
  );
}

function reasonText(reason: string | undefined): string {
  switch (reason) {
    case 'revoked':
      return 'The connection was revoked.';
    case 'expired':
      return 'The connection expired.';
    default:
      return 'It was never connected.';
  }
}

const Notice = styled.div`
  display: flex;
  align-items: center;
  gap: ${p => p.theme.size()};
  padding: ${p => p.theme.size()};
  border: 1px solid ${p => p.theme.colors.main};
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};
`;

const Text = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
`;
