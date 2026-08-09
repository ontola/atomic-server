import { frozenIdFor, type FrozenId, type JsonValue } from './freeze.js';
import {
  freezeSchema,
  type AtomicSchemaPackage,
  type DefinedSchema,
  type SchemaHash,
} from './schema.js';

/**
 * The committed, shareable schema artifact. A frozen id is a deterministic
 * function of the schema source, so this file makes a schema *available* without
 * any server: any implementation re-hashes the `frozen` objects to verify, and
 * registers them locally. See `verifySchemaLock`.
 *
 * Only `frozen` is hashed (identity-only JSON-AD). `@index` and `presentation`
 * are non-hashed human/metadata aids — editing them never moves an id.
 */
export interface SchemaLock {
  readonly name: string;
  readonly version?: string;
  readonly ontology: FrozenId;
  /** Frozen id -> `Ontology.shortname`, a human decoder. Not hashed. */
  readonly '@index': Record<string, string>;
  /** Frozen id -> identity-only canonical JSON-AD body. The hashed objects. */
  readonly frozen: Record<string, JsonValue>;
  readonly presentation: SchemaLockPresentation;
}

export interface SchemaLockPresentationEntry {
  readonly id: FrozenId;
  readonly description: string;
}

export interface SchemaLockPresentation {
  readonly ontology: {
    readonly description: string;
    readonly version?: string;
    readonly schemaHash: SchemaHash;
    readonly jsonSchema: AtomicSchemaPackage;
  };
  readonly classes: Record<string, SchemaLockPresentationEntry>;
  readonly properties: Record<string, SchemaLockPresentationEntry>;
}

/** Builds the committed lockfile for a schema (deterministic, server-free). */
export function buildSchemaLock(
  input: AtomicSchemaPackage | DefinedSchema,
): SchemaLock {
  const frozen = freezeSchema(input);
  const name = frozen.model.ontology.shortname;

  const index: Record<string, string> = {};

  const addIndex = (id: FrozenId, label: string): void => {
    // Cycle members share a unit id; join their labels rather than clobber.
    index[id] = index[id] ? `${index[id]} + ${label}` : label;
  };

  addIndex(frozen.ontology, name);

  for (const klass of frozen.model.classes) {
    addIndex(frozen.classes[klass.key], `${name}.${klass.shortname}`);
  }

  for (const property of frozen.model.properties) {
    addIndex(frozen.properties[property.key], `${name}.${property.shortname}`);
  }

  const frozenObjects: Record<string, JsonValue> = {};

  for (const resource of frozen.resources) {
    frozenObjects[resource.frozenId] = resource.content;
  }

  return {
    name,
    version: frozen.model.ontology.version,
    ontology: frozen.ontology,
    '@index': index,
    frozen: frozenObjects,
    presentation: {
      ontology: frozen.presentation.ontology,
      classes: mapPresentation(frozen.presentation.classes),
      properties: mapPresentation(frozen.presentation.properties),
    },
  };
}

export interface SchemaLockVerification {
  readonly ok: boolean;
  readonly errors: string[];
}

/**
 * Re-hashes every frozen object and checks it matches its id. This is the
 * language-neutral verification a consumer (or a CI stale-lockfile guard) runs;
 * it depends only on JCS + blake3, never on the freeze algorithm.
 */
export function verifySchemaLock(lock: SchemaLock): SchemaLockVerification {
  const errors: string[] = [];

  for (const [id, object] of Object.entries(lock.frozen)) {
    const actual = frozenIdFor(object);

    if (actual !== id) {
      errors.push(`Frozen object "${id}" hashes to "${actual}"`);
    }
  }

  if (!(lock.ontology in lock.frozen)) {
    errors.push(`Ontology id "${lock.ontology}" is missing from "frozen"`);
  }

  return { ok: errors.length === 0, errors };
}

function mapPresentation(
  entries: Record<string, { frozenId: FrozenId; description: string }>,
): Record<string, SchemaLockPresentationEntry> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      { id: value.frozenId, description: value.description },
    ]),
  );
}
