// @wc-ignore-file
import {
  principalIdentity,
  sourceKey,
  type SyncablePrincipal,
} from './builtinSyncIdentity';
import { platformLocalId } from './syncablePlatform';

export interface SyncableSourceConfigV2 {
  version: 2;
  proxyOrigin: string;
  platform: string;
  principal: SyncablePrincipal;
  connectionId?: string;
}

export interface SyncableSourceKeyV2 extends Omit<
  SyncableSourceConfigV2,
  'connectionId'
> {
  kind: 'principal';
}

export function parseSyncableSourceConfig(
  value: unknown,
): SyncableSourceConfigV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid saved principal source');
  const raw = value as Record<string, unknown>;
  const { version, proxyOrigin, platform, connectionId } = raw;
  if (
    version !== 2 ||
    typeof proxyOrigin !== 'string' ||
    typeof platform !== 'string' ||
    Object.keys(raw).some(
      key =>
        ![
          'version',
          'proxyOrigin',
          'platform',
          'principal',
          'connectionId',
        ].includes(key),
    )
  )
    throw new Error('Invalid saved principal source');
  platformLocalId(proxyOrigin, platform);
  const input = raw.principal as Record<string, unknown> | undefined;
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !['public', 'authenticated'].includes(String(input.kind))
  )
    throw new Error('Invalid Sync principal');
  const principal = principalIdentity(input);

  if (principal.kind === 'public') {
    if (Object.keys(input).length !== 1 || connectionId !== undefined)
      throw new Error('Invalid Public principal');
  } else {
    const namespace = new URL(principal.namespace);
    if (
      namespace.protocol !== 'https:' ||
      namespace.username ||
      namespace.password ||
      namespace.search ||
      namespace.hash ||
      Object.keys(input).some(
        key => !['kind', 'namespace', 'subject', 'clientContext'].includes(key),
      ) ||
      (connectionId !== undefined &&
        (typeof connectionId !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(connectionId)))
    )
      throw new Error('Invalid authenticated principal');
  }

  return {
    version,
    proxyOrigin,
    platform,
    principal,
    ...(typeof connectionId === 'string' ? { connectionId } : {}),
  };
}

export function parseSyncableSourceKey(raw: unknown): SyncableSourceKeyV2 {
  if (typeof raw !== 'string' || raw.length > 2000)
    throw new Error('Invalid Sync source identity');
  const { kind, ...fields } = JSON.parse(raw) as Record<string, unknown>;
  const source = parseSyncableSourceConfig(fields);
  if (kind !== 'principal' || sourceKey({ ...source, kind }) !== raw)
    throw new Error('Invalid canonical principal source');

  return { ...source, kind };
}

export function sourceConfigMatchesKey(
  config: SyncableSourceConfigV2,
  key: SyncableSourceKeyV2,
  raw: string,
): boolean {
  return sourceKey({ ...config, kind: key.kind }) === raw;
}
