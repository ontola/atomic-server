// @wc-ignore-file
/**
 * Connecting proxy platforms on an Installation (#1700, flow a, answer 3).
 *
 * A release manifest declares the platforms its plugin reaches through the
 * integration proxy (`proxy: ["clockify"]`). For each one, the page connects
 * the user's account at the proxy (or reuses a connection they already have),
 * delegates that connection to the Installation's app id, and records
 * `integrationConnections[platform] = connection_id` on the Installation in a
 * commit signed by the user. The host hands that map to the plugin as
 * `ctx.connections`. Disconnecting takes the delegation away at the proxy and
 * removes the key.
 *
 * Nothing here talks to the proxy for an Installation that declares no proxy
 * platform and has no recorded connection ({@link installationUsesProxy}).
 */
import {
  Datatype,
  core,
  server,
  type Resource,
  type Store,
} from '@tomic/react';
import {
  canonicalAgent,
  isPlatformId,
  ProxyError,
  type ProxyConnection,
  type ProxyConnections,
} from './proxyConnections';

export type InstallationConnectionMap = Record<string, string>;

/** The `proxy` platforms a release manifest declares; malformed ones dropped. */
export function proxyPlatformsOf(manifest: unknown): string[] {
  let parsed = manifest;

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }

  const proxy = (parsed as { proxy?: unknown } | null | undefined)?.proxy;
  if (!Array.isArray(proxy)) return [];

  return [...new Set(proxy.filter(isPlatformId))];
}

/** `integrationConnections` as `{platform: connection_id}`; junk dropped. */
export function connectionsOf(value: unknown): InstallationConnectionMap {
  let parsed = value;

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: InstallationConnectionMap = {};

  for (const [platform, id] of Object.entries(parsed)) {
    if (isPlatformId(platform) && typeof id === 'string' && id.trim())
      out[platform] = id;
  }

  return out;
}

/** Whether `release` names a Release resource the store can load. */
export function loadableRelease(release: unknown): release is string {
  return (
    typeof release === 'string' &&
    release.length > 0 &&
    !release.startsWith('blake3:')
  );
}

/** The platforms the Installation's pinned release declares in `proxy`. */
export async function installationProxyPlatforms(
  store: Store,
  installation: Resource,
): Promise<string[]> {
  const release = installation.get(server.properties.release);
  if (!loadableRelease(release)) return [];

  try {
    const resource = await store.getResource(release);

    return proxyPlatformsOf(resource.get(server.properties.manifest));
  } catch {
    return [];
  }
}

/**
 * Whether anything about this Installation needs the proxy: its manifest
 * declares a `proxy` platform, or it already has a recorded connection.
 * When not, the page makes no request to the proxy's origin at all.
 */
export function usesProxy(
  platforms: readonly string[],
  connections: InstallationConnectionMap,
): boolean {
  return platforms.length > 0 || Object.keys(connections).length > 0;
}

export async function installationUsesProxy(
  store: Store,
  installation: Resource,
): Promise<boolean> {
  const connections = connectionsOf(
    installation.get(server.properties.integrationConnections),
  );
  if (Object.keys(connections).length > 0) return true;

  return (await installationProxyPlatforms(store, installation)).length > 0;
}

/** Writes the map back, or removes the property once it is empty. */
async function writeConnections(
  store: Store,
  installation: string,
  change: (current: InstallationConnectionMap) => InstallationConnectionMap,
) {
  const resource = await store.getResource(installation);
  const next = change(
    connectionsOf(resource.get(server.properties.integrationConnections)),
  );

  if (Object.keys(next).length === 0) {
    resource.remove(server.properties.integrationConnections);
  } else {
    await resource.set(
      server.properties.integrationConnections,
      next,
      false,
      Datatype.JSON,
    );
  }

  // Signed by the signed-in user, who can write the Installation.
  await resource.save();
}

/** `integrationConnections[platform] = connectionId`, signed by the user. */
export function recordInstallationConnection(
  store: Store,
  installation: string,
  platform: string,
  connectionId: string,
): Promise<void> {
  if (!isPlatformId(platform)) throw new Error('Invalid platform');

  return writeConnections(store, installation, current => ({
    ...current,
    [platform]: connectionId,
  }));
}

/** Removes `platform` from `integrationConnections`, signed by the user. */
export function forgetInstallationConnection(
  store: Store,
  installation: string,
  platform: string,
): Promise<void> {
  return writeConnections(store, installation, current => {
    const { [platform]: _removed, ...rest } = current;

    return rest;
  });
}

function requireAppId(resource: Resource): string {
  const id = resource.get(server.properties.integrationAppAgent);
  let app: string | undefined;

  try {
    app = typeof id === 'string' ? canonicalAgent(id) : undefined;
  } catch {
    app = undefined;
  }

  if (!app)
    throw new Error(
      'This Installation has no app id, so it cannot be given a connection. Install it again.',
    );

  return app;
}

/** What a delegation is labelled with at the proxy. */
export function installationLabel(resource: Resource): string {
  const name = resource.get(core.properties.name);

  return typeof name === 'string' && name ? name : resource.subject;
}

/**
 * Starts `/connect` for `platform` on behalf of the Installation and returns
 * the proxy URL to send the person to. The return (`ProxyConnectReturn`)
 * redeems, delegates to the app id and records the connection.
 */
export async function startInstallationConnect(
  connections: ProxyConnections,
  resource: Resource,
  platform: string,
  returnTo: string,
): Promise<string> {
  const drive = resource.get(core.properties.parent);

  return connections.start(
    {
      drive: typeof drive === 'string' ? drive : '',
      app: resource.subject,
      appAgent: requireAppId(resource),
      recordOnInstallation: true,
    },
    platform,
    returnTo,
    installationLabel(resource),
  );
}

/**
 * Finishes a return from `/connect` (redeem, delegate) and, when it was
 * started for an Installation, records the new connection on it. Returns
 * where to go next.
 */
export async function finishProxyReturn(
  store: Store,
  connections: ProxyConnections,
  params: URLSearchParams,
): Promise<string> {
  const result = await connections.finish(params);

  if (result.connected && result.recordOnInstallation && result.connectionId)
    await recordInstallationConnection(
      store,
      result.app,
      result.platform,
      result.connectionId,
    );

  return result.returnTo;
}

/**
 * Delegates a connection the person already has to the Installation's app id
 * and records it.
 */
export async function delegateExistingConnection(
  store: Store,
  connections: ProxyConnections,
  resource: Resource,
  connection: ProxyConnection,
): Promise<void> {
  await connections.delegate(
    connection.connection_id,
    requireAppId(resource),
    installationLabel(resource),
  );
  await recordInstallationConnection(
    store,
    resource.subject,
    connection.platform,
    connection.connection_id,
  );
}

/**
 * Takes the delegation for `platform` away at the proxy, then removes the
 * key. A delegation the proxy no longer has (404) counts as gone.
 */
export async function disconnectInstallationPlatform(
  store: Store,
  connections: ProxyConnections,
  resource: Resource,
  platform: string,
): Promise<void> {
  const connectionId = connectionsOf(
    resource.get(server.properties.integrationConnections),
  )[platform];

  if (connectionId) {
    try {
      await connections.undelegate(connectionId, requireAppId(resource));
    } catch (e) {
      if (!(e instanceof ProxyError && e.status === 404)) throw e;
    }
  }

  await forgetInstallationConnection(store, resource.subject, platform);
}

/** The person's connections per platform, most recently used first. */
export async function existingConnectionsByPlatform(
  connections: ProxyConnections,
  platforms: readonly string[],
): Promise<Record<string, ProxyConnection[]>> {
  if (platforms.length === 0) return {};
  const rows = await connections.list();
  const out: Record<string, ProxyConnection[]> = {};

  for (const platform of platforms) {
    out[platform] = rows
      .filter(row => row.platform === platform)
      .sort((a, b) =>
        String(b.last_used_at ?? b.created_at ?? '').localeCompare(
          String(a.last_used_at ?? a.created_at ?? ''),
        ),
      );
  }

  return out;
}
