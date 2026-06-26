import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { Datatype } from './datatypes.js';
import {
  freezeResources,
  registerFrozenBodies,
  type FreezableResource,
  type FrozenId,
  type JsonValue as FreezeJsonValue,
} from './freeze.js';
import { jcsCanonicalize } from './jcs.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { registerOntologies } from './ontology.js';

type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

// Re-export the content-addressing primitive (but not its `JsonValue`, which
// would collide with the one above).
export {
  freezeResources,
  frozenIdFor,
  type FrozenId,
  type FreezableResource,
  type FrozenResource,
  type FreezeResult,
} from './freeze.js';

export type SchemaHash = `blake3:${string}`;

export const SCHEMA_HASH_PROPERTY =
  'https://atomicdata.dev/properties/schemaHash';

export interface SchemaImportReference {
  /** Ontology subject, usually `did:ad:{genesis}` or an HTTP URL. */
  subject: string;
  /** Expected Ontology package hash. Generation/registration must fail on mismatch. */
  expectedHash?: SchemaHash;
}

export interface AtomicSchemaPropertyDefinition {
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';
  format?: string;
  description?: string;
  default?: JsonValue;
  enum?: JsonValue[];
  items?: AtomicSchemaPropertyDefinition | SchemaRef;
  properties?: Record<string, AtomicSchemaPropertyDefinition | SchemaRef>;
  required?: string[];
  additionalProperties?: boolean | AtomicSchemaPropertyDefinition | SchemaRef;
  $ref?: string;
  'atomic:subject'?: string;
  'atomic:shortname'?: string;
  'atomic:datatype'?: Datatype | string;
  'atomic:classType'?: string;
  'atomic:recommends'?: string[];
  'atomic:allowsOnly'?: JsonValue[];
  'atomic:isDynamic'?: boolean;
  'atomic:isLocked'?: boolean;
}

export interface SchemaRef {
  $ref: string;
}

export interface AtomicSchemaClassDefinition {
  title?: string;
  description?: string;
  type: 'object';
  required?: string[];
  properties: Record<string, AtomicSchemaPropertyDefinition | SchemaRef>;
  $defs?: Record<string, AtomicSchemaClassDefinition>;
  'atomic:subject'?: string;
  'atomic:shortname'?: string;
  'atomic:recommends'?: string[];
}

export interface AtomicSchemaPackage {
  name: string;
  version?: string;
  description?: string;
  imports?: Record<string, SchemaImportReference>;
  classes: Record<string, AtomicSchemaClassDefinition>;
  $defs?: Record<string, AtomicSchemaClassDefinition>;
}

/** The class keys of a schema package, mapped to their `did:ad:frozen:` ids. */
export type SchemaClassHandles<S extends AtomicSchemaPackage> = {
  readonly [C in keyof S['classes']]: string;
};

/** Union of every property key across all classes of a schema package. */
export type SchemaPropertyKey<S extends AtomicSchemaPackage> = {
  [C in keyof S['classes']]: keyof S['classes'][C]['properties'] & string;
}[keyof S['classes']];

/** The property keys of a schema package, mapped to their `did:ad:frozen:` ids. */
export type SchemaPropertyHandles<S extends AtomicSchemaPackage> = {
  readonly [P in SchemaPropertyKey<S>]: string;
};

export interface DefinedSchema<
  Schema extends AtomicSchemaPackage = AtomicSchemaPackage,
> {
  readonly schema: Schema;
  readonly normalized: AtomicSchemaPackage;
  readonly schemaHash: SchemaHash;
  /**
   * Content-addressed `did:ad:frozen:` id for each class, keyed by class key.
   * Computed lazily and locally (no server) the first time it is read — use
   * directly as `isA` when creating resources. Self-contained schemas only;
   * accessing this on a schema with `$ref` imports throws.
   */
  readonly classes: SchemaClassHandles<Schema>;
  /**
   * Content-addressed `did:ad:frozen:` id for each property, keyed by property
   * key. Use directly as `propVals` keys.
   */
  readonly properties: SchemaPropertyHandles<Schema>;
}

export interface ConvertedSchemaProperty {
  readonly key: string;
  readonly classKey: string;
  readonly propertyKey: string;
  readonly subject?: string;
  readonly shortname: string;
  readonly description: string;
  readonly datatype: Datatype | string;
  readonly classType?: string;
  readonly allowsOnly?: JsonValue[];
  readonly isDynamic?: boolean;
  readonly isLocked?: boolean;
}

export interface ConvertedSchemaClass {
  readonly key: string;
  readonly subject?: string;
  readonly shortname: string;
  readonly description: string;
  readonly requires: string[];
  readonly recommends: string[];
}

export interface ConvertedSchemaOntology {
  readonly shortname: string;
  readonly description: string;
  readonly version?: string;
  readonly schemaHash: SchemaHash;
  readonly jsonSchema: AtomicSchemaPackage;
}

export interface ConvertedSchemaPackage {
  readonly ontology: ConvertedSchemaOntology;
  readonly classes: ConvertedSchemaClass[];
  readonly properties: ConvertedSchemaProperty[];
}

export function defineSchema<Schema extends AtomicSchemaPackage>(
  schema: Schema,
): DefinedSchema<Schema> {
  const normalized = normalizeSchemaPackage(schema);

  // `.classes` / `.properties` are content-addressed frozen ids. They are
  // computed lazily — on first access — so that (a) merely defining a schema
  // (or converting one to a model internally) does no hashing work, and (b) a
  // schema with `$ref` imports, which cannot be frozen without a store, only
  // errors if a caller actually reaches for the local handles.
  let handles: SchemaHandles | undefined;
  const getHandles = (): SchemaHandles => (handles ??= computeSchemaHandles(defined));

  const defined = Object.freeze({
    schema,
    normalized,
    schemaHash: hashSchemaPackage(normalized),
    get classes() {
      return getHandles().classes;
    },
    get properties() {
      return getHandles().properties;
    },
  }) as unknown as DefinedSchema<Schema>;

  return defined;
}

interface SchemaHandles {
  readonly classes: Record<string, string>;
  readonly properties: Record<string, string>;
}

/**
 * Freezes a self-contained schema into `did:ad:frozen:` ids and exposes them as
 * flat `{ classKey -> id }` / `{ propertyKey -> id }` handles. Also registers the
 * schema in the global runtime mapping so `resource.props.<shortname>` resolves
 * without any generated bindings.
 */
function computeSchemaHandles(defined: DefinedSchema): SchemaHandles {
  const frozen = freezeSchema(defined);

  const properties: Record<string, string> = {};

  for (const property of frozen.model.properties) {
    properties[property.propertyKey] = frozen.properties[property.key];
  }

  registerFrozenSchemaRuntime(frozen);
  // Make the frozen bodies publishable so the Store can lazily PUT them on save.
  registerFrozenBodies(frozen.resources);

  return { classes: { ...frozen.classes }, properties };
}

/**
 * Teaches `@tomic/lib`'s runtime about a frozen schema (subject -> shortname and
 * the per-class property set), so quick-access `resource.props` works for
 * code-first schemas the same way it does for generated ontologies.
 */
function registerFrozenSchemaRuntime(frozen: FrozenSchema): void {
  const properties: Record<string, string> = {};

  for (const property of frozen.model.properties) {
    properties[property.shortname] = frozen.properties[property.key];
  }

  const classes: Record<string, string> = {};
  const classDefs: Record<string, string[]> = {};

  for (const klass of frozen.model.classes) {
    const classId = frozen.classes[klass.key];
    classes[klass.shortname] = classId;
    classDefs[classId] = [...klass.requires, ...klass.recommends]
      .map(modelKey => frozen.properties[modelKey])
      .filter((id): id is FrozenId => Boolean(id));
  }

  registerOntologies({ classes, properties, __classDefs: classDefs });
}

export function schemaToOntologyModel(
  input: AtomicSchemaPackage | DefinedSchema,
): ConvertedSchemaPackage {
  const defined = isDefinedSchema(input) ? input : defineSchema(input);
  const schema = defined.normalized;
  const properties: ConvertedSchemaProperty[] = [];
  const classes = Object.entries(schema.classes).map(([classKey, klass]) => {
    const required = new Set(klass.required ?? []);
    const classPropertyKeys: Array<{ modelKey: string; propertyKey: string }> =
      [];

    for (const [propertyKey, propertyDefinition] of Object.entries(
      klass.properties,
    )) {
      if (
        isSchemaRef(propertyDefinition) &&
        isImportedPropertyRef(propertyDefinition.$ref)
      ) {
        classPropertyKeys.push({
          modelKey: `ref:${propertyDefinition.$ref}`,
          propertyKey,
        });
        continue;
      }

      const convertedProperty = convertPropertyDefinition(
        classKey,
        propertyKey,
        propertyDefinition,
      );

      properties.push(convertedProperty);
      classPropertyKeys.push({
        modelKey: convertedProperty.key,
        propertyKey,
      });
    }

    const requiredKeys = classPropertyKeys.filter(key =>
      required.has(key.propertyKey),
    );
    const recommendedKeys = classPropertyKeys.filter(
      key => !required.has(key.propertyKey),
    );

    return {
      key: classKey,
      subject: klass['atomic:subject'],
      shortname: klass['atomic:shortname'] ?? classKey,
      description: klass.description ?? klass.title ?? classKey,
      requires: requiredKeys.map(key => key.modelKey),
      recommends: recommendedKeys.map(key => key.modelKey),
    } satisfies ConvertedSchemaClass;
  });

  return {
    ontology: {
      shortname: schema.name,
      description: schema.description ?? schema.name,
      version: schema.version,
      schemaHash: defined.schemaHash,
      jsonSchema: schema,
    },
    classes,
    properties,
  };
}

export interface FrozenSchemaResource {
  readonly frozenId: FrozenId;
  /** Identity-only JSON-AD body with internal references resolved to FrozenIds. */
  readonly content: JsonValue;
}

export interface FrozenSchemaMetadata {
  readonly frozenId: FrozenId;
  /** Human description — presentation, not part of the frozen identity. */
  readonly description: string;
}

/**
 * Mutable, human-facing metadata that is deliberately NOT hashed into frozen
 * ids, so editing it (typo fixes, rewording, translations) never churns an id.
 * Keyed by the developer-facing model key so each usage keeps its own text even
 * when identical definitions dedupe to one frozen id.
 */
export interface FrozenSchemaPresentation {
  readonly ontology: {
    readonly description: string;
    readonly version?: string;
    readonly schemaHash: SchemaHash;
    readonly jsonSchema: AtomicSchemaPackage;
  };
  readonly classes: Record<string, FrozenSchemaMetadata>;
  readonly properties: Record<string, FrozenSchemaMetadata>;
}

export interface FrozenSchema {
  readonly ontology: FrozenId;
  readonly classes: Record<string, FrozenId>;
  readonly properties: Record<string, FrozenId>;
  readonly resources: FrozenSchemaResource[];
  readonly presentation: FrozenSchemaPresentation;
  readonly model: ConvertedSchemaPackage;
}

const FREEZE_NS = 'urn:atomic-freeze:';
const ONTOLOGY_LOCAL_ID = `${FREEZE_NS}ontology`;
const classLocalId = (key: string): string => `${FREEZE_NS}class:${key}`;
const propLocalId = (key: string): string => `${FREEZE_NS}prop:${key}`;

/**
 * Converts a schema package into content-addressed `did:ad:frozen` resources:
 * one materialized Ontology, Class, and Property JSON-AD body each, with every
 * cross-reference resolved to the referent's frozen hash. The whole body is
 * hashed (descriptions included), so the same definition always yields the same
 * id and any edit yields a new one.
 *
 * Self-contained schemas only: an imported property (`$ref:
 * "alias.properties.x"`) cannot be resolved to a frozen id without the
 * referenced Ontology, so callers needing imports must go through the
 * store-backed registration path.
 */
export function freezeSchema(
  input: AtomicSchemaPackage | DefinedSchema,
): FrozenSchema {
  const model = schemaToOntologyModel(input);
  const propertyKeys = new Set(model.properties.map(property => property.key));

  const resolveModelKey = (key: string): string => {
    if (propertyKeys.has(key)) {
      return propLocalId(key);
    }

    throw new Error(
      `freezeSchema cannot resolve property reference "${key}". Imported properties require store-backed registration.`,
    );
  };

  const freezable: FreezableResource[] = [];

  // Frozen bodies hold IDENTITY only — the machine contract that decides how
  // data is validated/interpreted. Presentation (descriptions, labels,
  // translations) is excluded so cosmetic edits never churn a frozen id; it
  // rides in the mutable package layer (`presentation`, below).
  for (const property of model.properties) {
    freezable.push({
      localId: propLocalId(property.key),
      content: compactContent({
        [core.properties.isA]: [core.classes.property],
        [core.properties.shortname]: property.shortname,
        [core.properties.datatype]: property.datatype,
        [core.properties.classtype]: property.classType,
        [core.properties.allowsOnly]: property.allowsOnly as
          | FreezeJsonValue
          | undefined,
        [core.properties.isDynamic]: property.isDynamic,
        [core.properties.isLocked]: property.isLocked,
      }),
    });
  }

  for (const klass of model.classes) {
    freezable.push({
      localId: classLocalId(klass.key),
      content: compactContent({
        [core.properties.isA]: [core.classes.class],
        [core.properties.shortname]: klass.shortname,
        [core.properties.requires]: klass.requires.map(resolveModelKey),
        [core.properties.recommends]: klass.recommends.map(resolveModelKey),
      }),
    });
  }

  freezable.push({
    localId: ONTOLOGY_LOCAL_ID,
    content: compactContent({
      [core.properties.isA]: [core.classes.ontology],
      [core.properties.shortname]: model.ontology.shortname,
      [core.properties.classes]: model.classes.map(klass =>
        classLocalId(klass.key),
      ),
      [core.properties.properties]: model.properties.map(property =>
        propLocalId(property.key),
      ),
      [server.properties.version]: model.ontology.version,
    }),
  });

  const { resources, byLocalId } = freezeResources(freezable);

  const requireId = (localId: string): FrozenId => {
    const frozenId = byLocalId.get(localId);

    if (!frozenId) {
      throw new Error(`freezeSchema did not produce an id for ${localId}`);
    }

    return frozenId;
  };

  const classes: Record<string, FrozenId> = {};
  const properties: Record<string, FrozenId> = {};

  for (const klass of model.classes) {
    classes[klass.key] = requireId(classLocalId(klass.key));
  }

  for (const property of model.properties) {
    properties[property.key] = requireId(propLocalId(property.key));
  }

  // A shortname must map to a single definition per ontology, so the lockfile
  // `@index` and generated bindings can key on it. Content-addressing makes this
  // forgiving: identical definitions across classes dedupe to one frozen id and
  // pass; only genuinely different definitions sharing a shortname are rejected.
  assertUniqueShortnames(
    model.ontology.shortname,
    'property',
    model.properties.map(p => [p.shortname, properties[p.key]] as const),
  );
  assertUniqueShortnames(
    model.ontology.shortname,
    'class',
    model.classes.map(k => [k.shortname, classes[k.key]] as const),
  );

  const presentation: FrozenSchemaPresentation = {
    ontology: {
      description: model.ontology.description,
      version: model.ontology.version,
      schemaHash: model.ontology.schemaHash,
      jsonSchema: model.ontology.jsonSchema,
    },
    classes: Object.fromEntries(
      model.classes.map(klass => [
        klass.key,
        { frozenId: classes[klass.key], description: klass.description },
      ]),
    ),
    properties: Object.fromEntries(
      model.properties.map(property => [
        property.key,
        { frozenId: properties[property.key], description: property.description },
      ]),
    ),
  };

  return {
    ontology: requireId(ONTOLOGY_LOCAL_ID),
    classes,
    properties,
    resources: resources.map(resource => ({
      frozenId: resource.frozenId,
      content: resource.content as JsonValue,
    })),
    presentation,
    model,
  };
}

function assertUniqueShortnames(
  ontologyShortname: string,
  kind: 'class' | 'property',
  entries: ReadonlyArray<readonly [shortname: string, frozenId: FrozenId]>,
): void {
  const idsByShortname = new Map<string, Set<FrozenId>>();

  for (const [shortname, frozenId] of entries) {
    const ids = idsByShortname.get(shortname) ?? new Set<FrozenId>();
    ids.add(frozenId);
    idsByShortname.set(shortname, ids);
  }

  for (const [shortname, ids] of idsByShortname) {
    if (ids.size > 1) {
      throw new Error(
        `Schema "${ontologyShortname}" defines ${ids.size} different ${kind} resources with shortname "${shortname}". A shortname must map to one ${kind} per ontology — make the definitions identical to share, or rename.`,
      );
    }
  }
}

function compactContent(
  entries: Record<string, FreezeJsonValue | undefined>,
): FreezeJsonValue {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  ) as FreezeJsonValue;
}

export function hashSchemaPackage(schema: AtomicSchemaPackage): SchemaHash {
  const canonical = canonicalizeSchemaPackage(schema);
  const hash = blake3(utf8ToBytes(canonical));

  return `blake3:${bytesToHex(hash)}`;
}

export function canonicalizeSchemaPackage(schema: AtomicSchemaPackage): string {
  return jcsCanonicalize(
    normalizeSchemaPackage(schema) as unknown as FreezeJsonValue,
  );
}

export function normalizeSchemaPackage<Schema extends AtomicSchemaPackage>(
  schema: Schema,
): Schema {
  return normalizeValue(schema) as unknown as Schema;
}

function normalizeValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Schema contains a non-finite number: ${value}`);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => {
      const normalized = normalizeValue(item);

      return normalized === undefined ? null : normalized;
    });
  }

  if (typeof value === 'object') {
    const normalizedEntries = Object.entries(
      value as Record<string, unknown>,
    ).flatMap(([key, child]) => {
      const normalized = normalizeValue(child);

      return normalized === undefined ? [] : [[key, normalized] as const];
    });

    return Object.fromEntries(
      normalizedEntries.sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  throw new Error(`Schema contains an unsupported value: ${String(value)}`);
}

function convertPropertyDefinition(
  classKey: string,
  propertyKey: string,
  propertyDefinition: AtomicSchemaPropertyDefinition | SchemaRef,
): ConvertedSchemaProperty {
  return {
    key: `${classKey}.${propertyKey}`,
    classKey,
    propertyKey,
    subject:
      'atomic:subject' in propertyDefinition
        ? propertyDefinition['atomic:subject']
        : undefined,
    shortname:
      ('atomic:shortname' in propertyDefinition
        ? propertyDefinition['atomic:shortname']
        : undefined) ?? propertyKey,
    description:
      'description' in propertyDefinition
        ? (propertyDefinition.description ?? propertyKey)
        : propertyKey,
    datatype:
      ('atomic:datatype' in propertyDefinition
        ? propertyDefinition['atomic:datatype']
        : undefined) ?? datatypeFromJsonSchema(propertyDefinition),
    classType:
      'atomic:classType' in propertyDefinition
        ? propertyDefinition['atomic:classType']
        : undefined,
    allowsOnly:
      ('atomic:allowsOnly' in propertyDefinition
        ? propertyDefinition['atomic:allowsOnly']
        : undefined) ??
      ('enum' in propertyDefinition ? propertyDefinition.enum : undefined),
    isDynamic:
      'atomic:isDynamic' in propertyDefinition
        ? propertyDefinition['atomic:isDynamic']
        : undefined,
    isLocked:
      'atomic:isLocked' in propertyDefinition
        ? propertyDefinition['atomic:isLocked']
        : undefined,
  };
}

function datatypeFromJsonSchema(
  propertyDefinition: AtomicSchemaPropertyDefinition | SchemaRef,
): Datatype {
  if (isSchemaRef(propertyDefinition)) {
    return Datatype.ATOMIC_URL;
  }

  switch (propertyDefinition.type) {
    case 'string':
      if (propertyDefinition.format === 'date') {
        return Datatype.DATE;
      }

      if (propertyDefinition.format === 'uri') {
        return Datatype.URI;
      }

      return Datatype.STRING;
    case 'integer':
      return Datatype.INTEGER;
    case 'number':
      return Datatype.FLOAT;
    case 'boolean':
      return Datatype.BOOLEAN;
    case 'array':
      return isSchemaRef(propertyDefinition.items)
        ? Datatype.RESOURCEARRAY
        : Datatype.JSON;
    case 'object':
      return Datatype.JSON;
    default:
      if (propertyDefinition.$ref) {
        return Datatype.ATOMIC_URL;
      }

      return Datatype.JSON;
  }
}

function isDefinedSchema(value: unknown): value is DefinedSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schema' in value &&
    'normalized' in value &&
    'schemaHash' in value
  );
}

function isSchemaRef(value: unknown): value is SchemaRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$ref' in value &&
    typeof (value as SchemaRef).$ref === 'string'
  );
}

function isImportedPropertyRef(ref: string): boolean {
  return /^[^.]+\.properties\.[^.]+$/.test(ref);
}
