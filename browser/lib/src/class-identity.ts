import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ATOMIC_CLASS_PREFIX,
  canonicalizeScheme,
  classSubject,
  identifierBody,
  isPropertySubject,
} from './subject.js';

/** Domain separation: a class ID can never equal a property ID or a blob hash. */
export const CLASS_IDENTITY_CONTEXT = 'atomic class identity v1';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

/** Byte order of the UTF-8 encoding, as Rust sorts `String`s. */
function compareUtf8(a: string, b: string): number {
  const x = utf8ToBytes(a);
  const y = utf8ToBytes(b);
  const len = Math.min(x.length, y.length);

  for (let i = 0; i < len; i++) {
    if (x[i] !== y[i]) {
      return x[i] - y[i];
    }
  }

  return x.length - y.length;
}

/**
 * Normalize and sort the `requires` members of a Class for hashing.
 *
 * A member is an `atomic:prop:{hex}` ID (`did:ad:prop:` is rewritten) or an
 * `http(s)` term used as it is. Anything else is rejected, as is a member
 * listed twice. See `docs/src/schema/class-identity.md`.
 */
export function normalizeRequires(requires: readonly string[]): string[] {
  const members = requires.map(member => {
    if (typeof member !== 'string') {
      throw new Error(`Not a valid required property: '${String(member)}'`);
    }

    if (isPropertySubject(member)) {
      const hex = identifierBody(member)?.slice('prop:'.length) ?? '';

      if (!HEX64_RE.test(hex)) {
        throw new Error(`Not a valid property identifier: '${member}'`);
      }

      return canonicalizeScheme(member);
    }

    if (member.startsWith('https://') || member.startsWith('http://')) {
      return member;
    }

    throw new Error(
      `A class can only require atomic:prop: IDs or http(s) properties, got '${member}'`,
    );
  });

  members.sort(compareUtf8);

  for (let i = 1; i < members.length; i++) {
    if (members[i] === members[i - 1]) {
      throw new Error(`Property '${members[i]}' is required more than once`);
    }
  }

  return members;
}

/**
 * The content-addressed ID of a Class: `atomic:class:{blake3-hex}`.
 *
 * `ontology` is the Class's `parent`. The order of `requires` does not matter,
 * and `recommends` is not an input. Throws on an invalid shortname, an empty
 * ontology or a `requires` member {@link normalizeRequires} rejects.
 */
export function classId(
  ontology: string,
  shortname: string,
  requires: readonly string[] = [],
): string {
  if (!SLUG_RE.test(shortname)) {
    throw new Error(`Not a valid shortname: '${shortname}'`);
  }

  if (!ontology) {
    throw new Error('A class needs an ontology');
  }

  // JCS of this object: keys sorted, no whitespace.
  const jcs = JSON.stringify({
    ontology: canonicalizeScheme(ontology),
    requires: normalizeRequires(requires),
    shortname,
  });

  const hash = blake3(utf8ToBytes(jcs), {
    context: utf8ToBytes(CLASS_IDENTITY_CONTEXT),
  });

  return classSubject(bytesToHex(hash));
}

/**
 * True for a well-formed `atomic:class:{64 lowercase hex}` identifier. There
 * is no legacy `did:ad:class:` spelling.
 */
export function isClassId(subject: string): boolean {
  if (!subject.startsWith(ATOMIC_CLASS_PREFIX)) {
    return false;
  }

  const hex = identifierBody(subject)?.slice('class:'.length) ?? '';

  return HEX64_RE.test(hex);
}

/** Does `subject` equal the ID derived from the given ontology, shortname and required properties? */
export function verifyClassId(
  subject: string,
  ontology: string,
  shortname: string,
  requires: readonly string[] = [],
): boolean {
  if (!isClassId(subject)) {
    return false;
  }

  try {
    return subject === classId(ontology, shortname, requires);
  } catch {
    return false;
  }
}
