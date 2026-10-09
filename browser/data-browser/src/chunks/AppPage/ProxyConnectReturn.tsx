import { useEffect, useState, type ReactNode } from 'react';
import { StoreEvents, useStore, type Agent } from '@tomic/react';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import { setIntegrationReturnListener } from '@helpers/integrationReturn';
import { ProxyConnections } from '@helpers/proxyConnections';

/**
 * Where an app's proxy connection comes back to.
 *
 * The integration proxy only returns to `/app/integrations`, with
 * `integration_state`. When that state is a handoff this browser started for
 * an app (`AppFrame`'s connect dialog), this takes over the page before any
 * route renders — so no route's own return handling sees it — redeems the
 * code signed with the user key (which makes the user the connection's owner),
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
  const [pending, setPending] = useState<Return | undefined>(() =>
    returnOf(store, new URLSearchParams(location.search)),
  );
  const [error, setError] = useState<string>();

  // The Tauri apps connect in the system browser, which comes back as an
  // `atomic://integrations/return` deep link instead of a page load.
  useEffect(
    () =>
      setIntegrationReturnListener(params => {
        const found = returnOf(store, params);

        if (found) setPending(found);
      }),
    [store],
  );

  useEffect(() => {
    if (!pending) return;
    history.replaceState(history.state, '', location.pathname);
    let cancelled = false;

    redeemOnce(store, pending.connections, pending.params)
      .then(returnTo => {
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

interface Return {
  connections: ProxyConnections;
  params: URLSearchParams;
}

/** `params` as a return this browser started, if it is one. */
function returnOf(
  store: ReturnType<typeof useStore>,
  params: URLSearchParams,
): Return | undefined {
  // Settings can hold a proxy value that no longer validates; that is never
  // a return this browser started.
  const connections = safely(
    () =>
      new ProxyConnections(localStorage, getIntegrationProxy(), () =>
        store.getAgent(),
      ),
  );

  return connections?.isReturn(params) ? { connections, params } : undefined;
}

/**
 * Redemptions in flight, by `integration_state`. `finish` consumes the pending
 * handoff, so a second call for the same return always fails; StrictMode in
 * development runs the effect twice, and the second run must wait for the
 * first run's redemption rather than start its own (#1883).
 */
const redemptions = new Map<string, Promise<string>>();

/** How long a settled redemption stays shared, for a remount right after. */
const KEEP_SETTLED_MS = 10_000;

function redeemOnce(
  store: ReturnType<typeof useStore>,
  connections: ProxyConnections,
  params: URLSearchParams,
): Promise<string> {
  const state = params.get('integration_state') ?? '';
  const known = redemptions.get(state);

  if (known) return known;

  // Redeeming is signed with the user key, which may still be loading this
  // early in a page load.
  const redemption = waitForAgent(store)
    .then(() => connections.finish(params))
    .then(({ returnTo }) => returnTo);
  redemptions.set(state, redemption);

  const forget = () =>
    setTimeout(() => {
      if (redemptions.get(state) === redemption) redemptions.delete(state);
    }, KEEP_SETTLED_MS);
  redemption.then(forget, forget);

  return redemption;
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
