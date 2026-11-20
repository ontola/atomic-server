// @wc-ignore-file
/** Shared consistency checks only; stored evidence never grants request or write authority. */
import {
  describeResourceFields,
  resolveEntityIdentity,
  resolveResourceField,
} from 'syncables/browser';
import { sourceConfigFingerprint } from './builtinSyncIdentity.js';
const object = value =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) =>
  sourceConfigFingerprint(a) === sourceConfigFingerprint(b);

export function validateSyncableReferenceEvidence(document, value, entity) {
  try {
    if (
      !object(value) ||
      value.version !== 1 ||
      typeof value.sourceResource !== 'string' ||
      !object(value.sourceEntity) ||
      !object(value.sourceRecord) ||
      !object(value.context) ||
      typeof value.field !== 'string' ||
      !Number.isSafeInteger(value.index) ||
      value.index < 0
    )
      return false;
    const source = resolveEntityIdentity(document, {
      resource: value.sourceResource,
      record: value.sourceRecord,
      context: value.context,
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
      value.context,
    );

    return (
      result.status === 'resolved' &&
      equal(result.objects[value.index]?.entity, entity)
    );
  } catch {
    return false;
  }
}
