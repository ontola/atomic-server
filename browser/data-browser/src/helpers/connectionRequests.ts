// @wc-ignore-file
/**
 * Connection requests (#1700 piece 9, flow b of ontola/atomic-plugins#54).
 *
 * A server-side run has nobody to send through OAuth. When a plugin's
 * `ctx.http("atomic-proxy:/<platform>/...")` finds no connection delegated to
 * its Installation, the node ends the run with a "needs a connection" outcome,
 * pauses the runs that need it, and writes a `ConnectionRequest` as a child of
 * its own `InstallationRuntime`, signed by its agent for the Installation.
 *
 * The page shows the open ones on the Installation, and once the person has
 * connected the platform it clears them: `connectionRequestClearedAt` in a
 * commit signed by the user, who must be able to write the Installation. The
 * node sees that through sync and resumes.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Datatype,
  core,
  server,
  CollectionBuilder,
  useChildren,
  type Resource,
  type Store,
} from '@tomic/react';
import { canonicalAgent, isPlatformId } from './proxyConnections';
import {
  readInstallationRuntimes,
  type InstallationRuntime,
} from './installationRuntimes';

export interface ConnectionRequest {
  subject: string;
  platform: string;
  /** `not-connected`, `revoked` or `expired`. */
  reason: string;
  /** When the node last found it needed the connection (ms). */
  requestedAt: number;
  clearedAt?: number;
  /** The node that asked. */
  runtime: InstallationRuntime;
}

function canonicalOrUndefined(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;

  try {
    return canonicalAgent(id);
  } catch {
    return undefined;
  }
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Reads `child` as a request of `runtime`, or `undefined` when it is not one.
 * It counts only when the runtime's own agent wrote it, as the node does.
 */
export function asConnectionRequest(
  child: Resource,
  runtime: InstallationRuntime,
): ConnectionRequest | undefined {
  if (!child.hasClasses(server.classes.connectionRequest)) return undefined;
  if (child.get(core.properties.parent) !== runtime.subject) return undefined;
  if (canonicalOrUndefined(child.getCreatedBy()) !== runtime.agent)
    return undefined;
  const platform = child.get(server.properties.connectionRequestPlatform);
  if (!isPlatformId(platform)) return undefined;
  const reason = child.get(server.properties.connectionRequestReason);

  return {
    subject: child.subject,
    platform,
    reason: typeof reason === 'string' ? reason : 'not-connected',
    requestedAt:
      numberOf(child.get(server.properties.connectionRequestedAt)) ?? 0,
    clearedAt: numberOf(
      child.get(server.properties.connectionRequestClearedAt),
    ),
    runtime,
  };
}

/** Still asking: never cleared, or asked again after it was. */
export function isOpenRequest(request: ConnectionRequest): boolean {
  return (
    request.clearedAt === undefined || request.clearedAt < request.requestedAt
  );
}

/**
 * Every request under `installation`'s runtimes, open or cleared.
 * `children` skips the query for the Installation's children when the caller
 * already has them.
 */
export async function readConnectionRequests(
  store: Store,
  installation: string,
  children?: readonly string[],
): Promise<ConnectionRequest[]> {
  const runtimes = await readInstallationRuntimes(
    store,
    installation,
    children,
  );
  const found: ConnectionRequest[] = [];

  for (const runtime of runtimes) {
    const subjects = await new CollectionBuilder(store)
      .setProperty(core.properties.parent)
      .setValue(runtime.subject)
      .setPageSize(100)
      .build()
      .getAllMembers();

    for (const subject of subjects) {
      try {
        const request = asConnectionRequest(
          await store.getResource(subject),
          runtime,
        );
        if (request) found.push(request);
      } catch {
        // A child that does not load is not a request we can show.
      }
    }
  }

  return found;
}

/**
 * Clears the open requests for `platform` under `installation`, each in a
 * commit signed by the signed-in user. Returns how many it cleared.
 */
export async function clearConnectionRequests(
  store: Store,
  installation: string,
  platform: string,
): Promise<number> {
  const open = (await readConnectionRequests(store, installation)).filter(
    r => r.platform === platform && isOpenRequest(r),
  );

  for (const request of open) {
    const resource = await store.getResource(request.subject);
    await resource.set(
      server.properties.connectionRequestClearedAt,
      Math.max(Date.now(), request.requestedAt),
      false,
      Datatype.TIMESTAMP,
    );
    await resource.save();
  }

  return open.length;
}

/**
 * The open requests under an Installation, read again when its children
 * change or after `refresh()`.
 */
export function useConnectionRequests(
  store: Store,
  installation: string,
  enabled: boolean,
): { open: ConnectionRequest[]; refresh: () => void } {
  const { subjects, loading } = useChildren(enabled ? installation : undefined);
  const key = subjects.join('\n');
  const [open, setOpen] = useState<ConnectionRequest[]>([]);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    if (!enabled || loading) return;
    let cancelled = false;

    readConnectionRequests(store, installation, subjects)
      .then(found => {
        if (!cancelled) setOpen(found.filter(isOpenRequest));
      })
      .catch(() => {
        // Shown as none; the page still offers to connect every platform.
      });

    return () => {
      cancelled = true;
    };
    // `key` stands for `subjects`, whose identity changes on every re-sort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, installation, enabled, loading, key, version]);

  return { open: enabled ? open : [], refresh };
}
