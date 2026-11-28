// @wc-ignore-file
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type SyncablePrincipal =
  | { kind: 'public' }
  | {
      kind: 'authenticated';
      namespace: string;
      subject: string | number;
      clientContext?: string;
    };

/** Deterministic source identities contain JSON values, never display names or Atomic paths. */
export function canonicalValue<T>(value: T): T;
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter(key => record[key] !== undefined)
        .map(key => [key, canonicalValue(record[key])]),
    );
  }

  return value;
}

export function sourceConfigFingerprint(value: unknown): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify(canonicalValue(value)) ?? 'undefined',
      ),
    ),
  );
}

export function principalIdentity(value: unknown): SyncablePrincipal {
  const principal = value as
    | {
        kind?: unknown;
        namespace?: unknown;
        subject?: unknown;
        clientContext?: unknown;
      }
    | null
    | undefined;

  if (principal?.kind === 'public') return { kind: 'public' };
  if (
    !principal ||
    typeof principal.namespace !== 'string' ||
    !principal.namespace ||
    (principal.clientContext !== undefined &&
      (typeof principal.clientContext !== 'string' ||
        !principal.clientContext)) ||
    !(
      (typeof principal.subject === 'string' && principal.subject.length) ||
      (typeof principal.subject === 'number' &&
        Number.isSafeInteger(principal.subject))
    )
  )
    throw new Error('The source has no durable principal identity');

  return {
    kind: 'authenticated',
    namespace: principal.namespace,
    subject: principal.subject,
    ...(principal.clientContext
      ? { clientContext: principal.clientContext }
      : {}),
  };
}

export function sourceKey(input: {
  kind: 'principal';
  platform: string;
  proxyOrigin: string;
  principal: SyncablePrincipal;
}): string {
  const serialized = JSON.stringify(
    canonicalValue({
      version: 2,
      kind: input.kind,
      platform: input.platform,
      proxyOrigin: input.proxyOrigin,
      principal: principalIdentity(input.principal),
    }),
  );
  if (serialized.length > 2000)
    throw new Error(
      'The source identity exceeds the 2000 character query limit',
    );

  return serialized;
}
