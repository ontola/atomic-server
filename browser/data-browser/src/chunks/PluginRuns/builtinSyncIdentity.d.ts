export type SyncablePrincipal =
  | { kind: 'public' }
  | {
      kind: 'authenticated';
      namespace: string;
      subject: string | number;
      clientContext?: string;
    };
export interface SourceKeyInput {
  version?: 2 | 3;
  proxyOrigin: string;
  platform: string;
  kind: string;
  resource?: string;
  entityIdentityHash?: string;
  principal: SyncablePrincipal;
  collection?: Record<string, unknown>;
  parentSourceKey?: string;
  parentSourceKeyHash?: string;
  remoteId?: string | number;
}
/** Provider compatibility is interpreted natively before descriptors reach the iframe. */
export interface LegacySourceAlias {
  subject: string;
  sourceKey?: string;
  localId?: string;
  kind: 'principal' | 'collection' | 'record';
  connectionId?: string;
  principal?: SyncablePrincipal;
  collection?: Record<string, unknown>;
  parentSourceSubject?: string;
  parentSourceKey?: string;
  remoteId?: string | number;
  previousParent?: string;
  reparentToLogicalParent?: boolean;
  sourceConfigFingerprint?: string;
  remoteIdProperty?: string;
}
export function canonicalValue<T>(value: T): T;
export function sourceConfigFingerprint(value: unknown): string;
export function principalIdentity(principal: unknown): SyncablePrincipal;
export function sourceKey(input: SourceKeyInput): string;
export function collectionIdentity(
  bound?: {
    collection: string;
    resource: string;
    pathParams: Record<string, string>;
  },
  navigation?: {
    collection: string;
    resource: string;
    reference?: string;
    link?: string;
  },
): Record<string, unknown>;

export interface CanonicalEntityIdentity {
  resource: string;
  template: string;
  values: [string, string | number][];
  path: string;
  key: string;
}
export function entitySourceKey(
  input: Pick<SourceKeyInput, 'proxyOrigin' | 'platform' | 'principal'> & {
    entityIdentity: CanonicalEntityIdentity;
  },
): string;
export function entityTableKey(
  input: Pick<SourceKeyInput, 'proxyOrigin' | 'platform' | 'principal'> & {
    resource: string;
  },
): string;

export function ruleSourceKey(tableKey: string, ruleKey: string): string;
export interface FlatIdentityAlias {
  canonicalSourceKey: string;
  canonicalConfig?: Record<string, unknown>;
  entityTableSourceKey?: string;
  subject: string;
  previousSourceKey?: string;
  localId?: string;
  sourceConfigFingerprint?: string;
  previousParent?: string;
  reparentToLogicalParent?: boolean;
}
export interface FlatMigrationBlock {
  principal: SyncablePrincipal;
  resource: string;
  message: string;
}
