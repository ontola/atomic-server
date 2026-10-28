import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classId,
  isClassId,
  normalizeRequires,
  verifyClassId,
} from './class-identity.js';
import { propertyId } from './property-identity.js';

interface Case {
  name: string;
  ontology: string;
  shortname: string;
  requires: string[];
  id?: string;
}

// The vectors shared with `lib/src/class_identity.rs`.
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../lib/tests/fixtures/class-identity.json', import.meta.url),
    'utf8',
  ),
) as { context: string; valid: Case[]; invalid: Case[] };

const ONTOLOGY = 'atomic:ontologyGenesis';
const STRING = 'https://atomicdata.dev/datatypes/string';
const SLUG = 'https://atomicdata.dev/datatypes/slug';
const A = propertyId(ONTOLOGY, 'name', STRING);
const B = propertyId(ONTOLOGY, 'name', SLUG);

describe('shared fixture (lib/tests/fixtures/class-identity.json)', () => {
  it('has the same context string as the implementation', () => {
    expect(fixture.context).toBe('atomic class identity v1');
  });

  it('covers every kind of case', () => {
    expect(fixture.valid.length).toBeGreaterThanOrEqual(10);
    expect(fixture.invalid.length).toBeGreaterThanOrEqual(12);
  });

  it.each(fixture.valid.map(c => [c.name, c] as const))(
    'valid: %s',
    (_name, c) => {
      expect(classId(c.ontology, c.shortname, c.requires)).toBe(c.id);
      expect(isClassId(c.id!)).toBe(true);
      expect(verifyClassId(c.id!, c.ontology, c.shortname, c.requires)).toBe(
        true,
      );
    },
  );

  it.each(fixture.invalid.map(c => [c.name, c] as const))(
    'invalid: %s',
    (_name, c) => {
      expect(() => classId(c.ontology, c.shortname, c.requires)).toThrow();
      expect(
        verifyClassId(
          'atomic:class:' + '0'.repeat(64),
          c.ontology,
          c.shortname,
          c.requires,
        ),
      ).toBe(false);
    },
  );
});

describe('classId', () => {
  it('does not depend on the order of requires', () => {
    expect(classId(ONTOLOGY, 'task', [A, B])).toBe(
      classId(ONTOLOGY, 'task', [B, A]),
    );
  });

  it('treats a missing requires as an empty one', () => {
    expect(classId(ONTOLOGY, 'task')).toBe(classId(ONTOLOGY, 'task', []));
  });

  it('normalizes did:ad: spellings', () => {
    expect(
      classId('did:ad:ontologyGenesis', 'task', [
        A.replace('atomic:', 'did:ad:'),
      ]),
    ).toBe(classId(ONTOLOGY, 'task', [A]));
  });

  it('changes with requires, ontology and shortname', () => {
    const base = classId(ONTOLOGY, 'task', [A]);

    expect(classId(ONTOLOGY, 'task', [A, B])).not.toBe(base);
    expect(classId(ONTOLOGY, 'task', [])).not.toBe(base);
    expect(classId(ONTOLOGY, 'todo', [A])).not.toBe(base);
    expect(classId('atomic:other', 'task', [A])).not.toBe(base);
  });

  it('does not collide with a property ID of the same ontology and name', () => {
    expect(classId(ONTOLOGY, 'name').slice('atomic:class:'.length)).not.toBe(
      propertyId(ONTOLOGY, 'name', STRING).slice('atomic:prop:'.length),
    );
  });

  it('rejects bad shortnames and an empty ontology', () => {
    for (const bad of ['', 'Name', 'my name', '-a', 'a-', 'a--b', 'a_b']) {
      expect(() => classId(ONTOLOGY, bad, [A])).toThrow();
    }

    expect(() => classId('', 'task', [A])).toThrow();
  });

  it('rejects members of another kind and malformed property IDs', () => {
    const hex = 'a'.repeat(64);

    for (const bad of [
      `atomic:lens:${hex}`,
      `atomic:class:${hex}`,
      `did:ad:class:${hex}`,
      'atomic:prop:ABCD',
      `atomic:prop:${'A'.repeat(64)}`,
      'atomic:prop:',
      'internal:/name',
      'name',
      '',
    ]) {
      expect(() => classId(ONTOLOGY, 'task', [bad]), bad).toThrow();
    }
  });

  it('rejects a member listed twice, also across spellings', () => {
    expect(() => classId(ONTOLOGY, 'task', [A, A])).toThrow();
    expect(() =>
      classId(ONTOLOGY, 'task', [A, A.replace('atomic:', 'did:ad:')]),
    ).toThrow();
  });

  it('hashes http members as they are', () => {
    const core = 'https://atomicdata.dev/properties/name';

    expect(classId(ONTOLOGY, 'task', [core, A])).toMatch(/^atomic:class:/);
    expect(classId(ONTOLOGY, 'task', [core])).not.toBe(
      classId(ONTOLOGY, 'task', [A]),
    );
  });
});

describe('normalizeRequires', () => {
  it('sorts in UTF-8 byte order, as Rust does', () => {
    // UTF-16 order puts U+FF5E (BMP) after U+1F600 (astral, a surrogate pair);
    // UTF-8 byte order puts it before.
    expect(normalizeRequires(['https://x/\u{1F600}', 'https://x/～'])).toEqual([
      'https://x/～',
      'https://x/\u{1F600}',
    ]);
  });
});

describe('isClassId', () => {
  it('is strict', () => {
    const hex = 'a'.repeat(64);

    expect(isClassId(`atomic:class:${hex}`)).toBe(true);
    expect(isClassId('atomic:class:')).toBe(false);
    expect(isClassId('atomic:class:ABCD')).toBe(false);
    expect(isClassId(`atomic:class:${'A'.repeat(64)}`)).toBe(false);
    expect(isClassId(`atomic:class:${hex}0`)).toBe(false);
    expect(isClassId(`atomic:prop:${hex}`)).toBe(false);
    // No legacy spelling.
    expect(isClassId(`did:ad:class:${hex}`)).toBe(false);
  });
});

describe('verifyClassId', () => {
  it('accepts a match and rejects a mismatch', () => {
    const id = classId(ONTOLOGY, 'task', [A, B]);

    expect(verifyClassId(id, ONTOLOGY, 'task', [B, A])).toBe(true);
    expect(verifyClassId(id, ONTOLOGY, 'task', [A])).toBe(false);
    expect(verifyClassId(id, ONTOLOGY, 'todo', [A, B])).toBe(false);
    expect(verifyClassId(A, ONTOLOGY, 'task', [A, B])).toBe(false);
    expect(verifyClassId(id, ONTOLOGY, 'Bad', [A, B])).toBe(false);
  });
});
