import { useEffect, useState, type ReactNode } from 'react';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import { ProxyConnections } from '@helpers/proxyConnections';

/**
 * Where an app's proxy connection comes back to.
 *
 * The integration proxy only returns to `/app/integrations`, with
 * `integration_state`. When that state is a handoff this browser started for
 * an app (`AppFrame`'s connect bar), this takes over the page before any route
 * renders — so no route's own return handling sees it — redeems the code,
 * keeps the connection in this page's storage, and goes back to the app,
 * which then finds the connection by reference. Any other page load renders
 * `children` untouched.
 */
export function ProxyConnectReturn({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [pending] = useState(() => {
    const params = new URLSearchParams(location.search);

    // Settings can hold a proxy value that no longer validates; that is never
    // a return this browser started.
    const connections = safely(
      () => new ProxyConnections(localStorage, getIntegrationProxy()),
    );

    return connections?.isReturn(params) ? { connections, params } : undefined;
  });
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!pending) return;
    history.replaceState(history.state, '', location.pathname);
    pending.connections
      .finish(pending.params)
      .then(({ returnTo }) => location.replace(returnTo))
      .catch((e: Error) => setError(e.message));
  }, [pending]);

  if (!pending) return <>{children}</>;

  return (
    <p role={error ? 'alert' : 'status'} style={{ padding: '1rem' }}>
      {error ?? 'Finishing the connection…'}
    </p>
  );
}

function safely<T>(make: () => T): T | undefined {
  try {
    return make();
  } catch {
    return undefined;
  }
}
