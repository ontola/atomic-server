// @wc-ignore-file
/** Shared consistency checks only; stored evidence never grants request or write authority. */
import {
  describeResourceFields,
  resolveEntityIdentity,
  resolveResourceField,
  type EntityIdentity,
  type OpenApiDocument,
  type TypedReadContext,
} from 'syncables/browser';
import { sourceConfigFingerprint } from './builtinSyncIdentity.js';

export interface SyncableReferenceEvidence {
  version: 1;
  sourceResource: string;
  sourceEntity: EntityIdentity;
  sourceRecord: Record<string, unknown>;
  context: TypedReadContext;
  field: string;
  index: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const equal = (a: unknown, b: unknown) =>
  sourceConfigFingerprint(a) === sourceConfigFingerprint(b);

/** Stored reference evidence proves consistency only. */
export function validateSyncableReferenceEvidence(
  document: OpenApiDocument,
  value: unknown,
  entity: EntityIdentity,
): boolean {
  try {
    if (
      !object(value) ||
      value.version !== 1 ||
      typeof value.sourceResource !== 'string' ||
      !object(value.sourceEntity) ||
      !object(value.sourceRecord) ||
      !object(value.context) ||
      typeof value.field !== 'string' ||
      typeof value.index !== 'number' ||
      !Number.isSafeInteger(value.index) ||
      value.index < 0
    )
      return false;
    const context = value.context as TypedReadContext;
    const source = resolveEntityIdentity(document, {
      resource: value.sourceResource,
      record: value.sourceRecord,
      context,
    });
    if (!equal(source, value.sourceEntity)) return false;
    const descriptor = describeResourceFields(
      document,
      value.sourceResource,
    ).find(field => field.field === value.field);
    if (!descriptor) return false;
    const result = resolveResourceField(
      document,
      descriptor,
      value.sourceRecord,
      context,
    );

    return (
      result.status === 'resolved' &&
      equal(result.objects[value.index]?.entity, entity)
    );
  } catch {
    return false;
  }
}
