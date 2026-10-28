import { classId, isClassId } from './class-identity.js';
import { core } from './ontologies/core.js';
import { isPropertyId, propertyId } from './property-identity.js';
import { canonicalizeScheme } from './subject.js';

/** The part of a Resource the check reads. */
interface Readable {
  get(prop: string): unknown;
}

/** True for an `atomic:prop:` or `atomic:class:` subject. */
export function isVerifiableSubject(subject: string): boolean {
  return isPropertyId(subject) || isClassId(subject);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Check that a Property or Class subject is the hash of the fields in the
 * resource it names: `parent`, `shortname` and `datatype` for a Property,
 * `parent`, `shortname` and `requires` for a Class. Other subjects return
 * `undefined`. Mirrors the server's check on a genesis commit
 * (`lib/src/commit.rs`).
 *
 * Returns the reason when the fields do not hash to the subject.
 */
export function contentAddressedMismatch(
  subject: string,
  resource: Readable,
): string | undefined {
  const canonical = canonicalizeScheme(subject);
  const parent = text(resource.get(core.properties.parent));
  const shortname = text(resource.get(core.properties.shortname));

  try {
    if (isClassId(canonical)) {
      const requires = resource.get(core.properties.requires) ?? [];

      if (
        !parent ||
        !shortname ||
        !Array.isArray(requires) ||
        !requires.every(r => typeof r === 'string')
      ) {
        return `Class ${subject} has no usable parent, shortname or requires; its ID is derived from them`;
      }

      return classId(parent, shortname, requires) === canonical
        ? undefined
        : `Class ID mismatch: ${subject} is not the hash of its parent, shortname and required properties`;
    }

    if (isPropertyId(canonical)) {
      const datatype = text(resource.get(core.properties.datatype));

      if (!parent || !shortname || !datatype) {
        return `Property ${subject} has no parent, shortname or datatype; its ID is derived from them`;
      }

      return propertyId(parent, shortname, datatype) === canonical
        ? undefined
        : `Property ID mismatch: ${subject} is not the hash of its parent, shortname and datatype`;
    }
  } catch (error) {
    return `${subject} is not a valid content-addressed ID: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  return undefined;
}
