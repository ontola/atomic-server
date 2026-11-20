import type {
  EntityIdentity,
  OpenApiDocument,
  TypedReadContext,
} from 'syncables/browser';

export interface SyncableReferenceEvidence {
  version: 1;
  sourceResource: string;
  sourceEntity: EntityIdentity;
  sourceRecord: Record<string, unknown>;
  context: TypedReadContext;
  field: string;
  index: number;
}
/** Consistency only: never authorizes requests, scopes or writes. */
export function validateSyncableReferenceEvidence(
  document: OpenApiDocument,
  evidence: unknown,
  entity: EntityIdentity,
): boolean;
