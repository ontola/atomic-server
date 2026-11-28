// @wc-ignore-file
import { parseDocument } from 'yaml';
import { isHttpsOrLoopback } from '@helpers/runtimeSetting';
import { readLimitedResponseText } from '@helpers/proxyConnections';
import { core, subjectsReferToSameResource, type Store } from '@tomic/lib';
import { findSyncablePlatform } from './syncablePlatform';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Only public declarative metadata enters the frame; provider reads stay scoped. */
export async function fetchSyncableDocument(
  origin: string,
  signal: AbortSignal,
  platform: string,
) {
  const base = new URL(origin);
  if (base.origin !== origin || !isHttpsOrLoopback(base))
    throw new Error('Invalid integration catalog origin');
  if (!/^[a-z0-9-]{1,80}$/.test(platform))
    throw new Error('Invalid integration platform ID');
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

  const read = async (path: string, optional = false) => {
    const response = await fetch(new URL(path, base), {
      signal: timeout,
      credentials: 'omit',
      redirect: 'error',
      headers: { Accept: 'application/yaml, application/json' },
    });
    if (optional && response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(
        'Integration catalog read failed (HTTP ' + response.status + ')',
      );
    const text = await readLimitedResponseText(response, 'Integration catalog');
    if (text.length > 1_048_576)
      throw new Error('Integration catalog exceeds 1 MB');

    return text;
  };

  const [source, selection] = await Promise.all([
    read(`/catalog/${platform}.yaml`),
    read(`/catalog/${platform}.selection.json`, true),
  ]);
  signal.throwIfAborted();
  const parsed = parseDocument(source!, { strict: true, uniqueKeys: true });
  if (parsed.errors.length || parsed.warnings.length)
    throw new Error('Invalid integration catalog YAML');
  const document: unknown = parsed.toJS({ maxAliasCount: 25 });
  if (
    !object(document) ||
    !object(document.paths) ||
    !Array.isArray(document.servers)
  )
    throw new Error('Invalid integration OpenAPI document');
  const server = document.servers[0];
  if (!object(server) || typeof server.url !== 'string')
    throw new Error('The integration catalog must declare an API server');
  const upstream = new URL(server.url);
  if (
    !isHttpsOrLoopback(upstream) ||
    upstream.username ||
    upstream.password ||
    upstream.hash
  )
    throw new Error('Invalid integration API server');
  const querySelection: unknown =
    selection === undefined ? undefined : JSON.parse(selection);
  if (querySelection !== undefined && !object(querySelection))
    throw new Error('Invalid integration catalog selection');

  return { document, ...(querySelection ? { querySelection } : {}) };
}

/** Provider branding is public metadata, never an executable entry point. */
export function syncableBranding(document: unknown) {
  const info = object(document) && object(document.info) ? document.info : {};
  const name = typeof info.title === 'string' ? info.title.trim() : undefined;
  const logo = object(info['x-logo']) ? info['x-logo'] : {};

  return {
    name: name && name.length <= 120 ? name : undefined,
    icon: typeof logo.url === 'string' ? logo.url : undefined,
  };
}

/** Descendant views reuse the installation's saved public metadata, without I/O to the provider. */
export async function storedSyncableDocument(
  store: Store,
  drive: string,
  subject: string,
  source: {
    platform: string;
    proxyOrigin: string;
    schema: { properties: Record<string, string> };
  },
) {
  const p = source.schema.properties;
  const seen = new Set<string>();
  let current = subject;
  let saved;

  while (!seen.has(current) && seen.size < 64) {
    if (subjectsReferToSameResource(current, drive)) {
      if (saved) return saved;
      const installation = await findSyncablePlatform(store, {
        drive,
        platform: source.platform,
        proxyOrigin: source.proxyOrigin,
      });
      if (!installation) return {};
      const app = await store.getResource(installation);
      const document = app.get(p['syncable-api-document']);

      return object(document)
        ? { document, querySelection: app.get(p['syncable-api-selection']) }
        : {};
    }

    seen.add(current);
    const resource = await store.getResource(current);
    if (resource.error) throw resource.error;
    const assignedDrive = resource.get(
      'https://atomicdata.dev/properties/drive',
    );
    if (
      assignedDrive !== undefined &&
      (typeof assignedDrive !== 'string' ||
        !subjectsReferToSameResource(assignedDrive, drive))
    )
      break;
    const document = resource.get(p['syncable-api-document']);
    if (
      !saved &&
      object(document) &&
      resource.get(p['syncable-platform-id']) === source.platform &&
      resource.get(p['syncable-proxy-origin']) === source.proxyOrigin
    )
      saved = {
        document,
        querySelection: resource.get(p['syncable-api-selection']),
      };
    const parent = resource.get(core.properties.parent);
    if (typeof parent !== 'string') break;
    current = parent;
  }

  throw new Error('The integration metadata is outside the selected drive');
}
