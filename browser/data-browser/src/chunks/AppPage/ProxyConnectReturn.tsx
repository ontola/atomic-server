import { useEffect, useState, type ReactNode } from 'react';
import { StoreEvents, useStore, type Agent } from '@tomic/react';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import { ProxyConnections } from '@helpers/proxyConnections';

/**
 * Where an app's proxy connection comes back to.
 *
 * The integration proxy only returns to `/app/integrations`, with
 * `integration_state`. When that state is a handoff this browser started for
 * an app (`AppFrame`'s connect bar), this takes over the page before any route
 * renders — so no route's own return handling sees it — redeems the code
 * signed with the user key (which makes the user the connection's owner),
 * delegates the connection to the app, and goes back to the app, which then
 * finds the connection by reference. Any other page load renders `children`
 * untouched.
 */
export function ProxyConnectReturn({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const store = useStore();
  const [pending] = useState(() => {
    const params = new URLSearchParams(location.search);

    // Settings can hold a proxy value that no longer validates; that is never
    // a return this browser started.
    const connections = safely(
      () =>
        new ProxyConnections(localStorage, getIntegrationProxy(), () =>
          store.getAgent(),
        ),
    );

    return connections?.isReturn(params) ? { connections, params } : undefined;
  });
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!pending) return;
    history.replaceState(history.state, '', location.pathname);
    let cancelled = false;

    // Redeeming is signed with the user key, which may still be loading this
    // early in a page load.
    waitForAgent(store)
      .then(() => pending.connections.finish(pending.params))
      .then(({ returnTo }) => {
        if (!cancelled) location.replace(returnTo);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, [pending, store]);

  if (!pending) return <>{children}</>;

  return (
    <p role={error ? 'alert' : 'status'} style={{ padding: '1rem' }}>
      {error ?? 'Finishing the connection…'}
    </p>
  );
}

/** The signed-in agent, once there is one; gives up after 30 s. */
function waitForAgent(store: ReturnType<typeof useStore>): Promise<Agent> {
  const now = store.getAgent();
  if (now) return Promise.resolve(now);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('Sign in to finish connecting this account.'));
    }, 30_000);
    const off = store.on(StoreEvents.AgentChanged, agent => {
      if (!agent) return;
      clearTimeout(timer);
      off();
      resolve(agent);
    });
  });
}

function safely<T>(make: () => T): T | undefined {
  try {
    return make();
  } catch {
    return undefined;
  }
}
