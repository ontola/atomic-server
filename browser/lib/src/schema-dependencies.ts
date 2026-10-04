import type { LoroDoc } from 'loro-crdt';
import type { Resource } from './resource.js';
import type { Store } from './store.js';
import { core } from './ontologies/core.js';
import {
  canonicalSchemaJson,
  APP_SHAPE,
  isFrozenSchema,
  type SchemaValue,
} from './schema-frozen.js';
import { parseAppDefinition, appShapeDatatype } from './app-schema.js';
import {
  normalizeAppShape,
  validateAppValue,
  type AppShape,
} from './schema-shape.js';
import { canonicalizeScheme } from './subject.js';

export const SCHEMA_ROOT = 'atomic:schema-definitions';
export const MAX_SCHEMA_DEFINITIONS = 512;
export const MAX_SCHEMA_BYTES = 1024 * 1024;
const size = (s: string) => new TextEncoder().encode(s).length;
const identifier = (id: string) => canonicalizeScheme(id).split(/[?#]/)[0];
type Definitions = Map<string, Resource>;
type Lookup = (id: string) => Resource | undefined;

// Legacy materialization can encode isA as a scalar or a JSON array string.
// Dependency discovery and validation must interpret both identically.
function classIds(value: SchemaValue | undefined): string[] {
  let parsed = value;

  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      parsed = JSON.parse(value) as SchemaValue;
    } catch {
      /* Treat as a literal identifier. */
    }
  }

  if (typeof parsed === 'string') return [parsed];
  if (Array.isArray(parsed))
    return parsed.filter((id): id is string => typeof id === 'string');

  return [];
}

function links(
  values: Record<string, SchemaValue>,
  definition: boolean,
): string[] {
  const ids = Object.keys(values).filter(isFrozenSchema).map(identifier);
  const keys = definition
    ? [
        core.properties.isA,
        core.properties.requires,
        core.properties.recommends,
        core.properties.datatype,
        core.properties.classtype,
      ]
    : [core.properties.isA];

  for (const key of keys) {
    const v = values[key];
    if (v === undefined) continue;
    const list =
      key === core.properties.isA
        ? classIds(v)
        : typeof v === 'string'
          ? [v]
          : v;
    if (!Array.isArray(list) || list.some(item => typeof item !== 'string'))
      throw new Error('Invalid schema links');
    for (const id of list as string[])
      if (isFrozenSchema(id)) ids.push(identifier(id));
  }

  return ids;
}

function checkDefinition(
  id: string,
  body: Record<string, SchemaValue>,
): Resource {
  const resource = parseAppDefinition(id, body);
  const classes = body[core.properties.isA];

  for (const key of [core.properties.shortname, core.properties.description]) {
    if (typeof body[key] !== 'string') throw new Error('Missing schema text');
  }

  if (JSON.stringify(classes) === JSON.stringify([core.classes.class])) {
    const required = body[core.properties.requires],
      recommended = body[core.properties.recommends];
    if (
      !Array.isArray(required) ||
      !Array.isArray(recommended) ||
      [...required, ...recommended].some(link => typeof link !== 'string') ||
      required.length + recommended.length > 128
    )
      throw new Error('Invalid class dependency');
  } else if (
    JSON.stringify(classes) === JSON.stringify([core.classes.property])
  ) {
    const shape = normalizeAppShape(body[APP_SHAPE] as AppShape);
    if (body[core.properties.datatype] !== appShapeDatatype(shape))
      throw new Error('Shape/datatype mismatch');
  } else throw new Error('Dependency must be an app Class or Property');

  return resource;
}

// Entries are memoized only when the same ID AND exact body arrive again.
// This cache cannot resolve a missing definition and contains no Store handles.
const verifiedBodies = new Map<
  string,
  { text: string; resource: Resource; bytes: number }
>();
let cachedBytes = 0;
const CACHE_ENTRIES = 256;
const CACHE_BYTES = 4 * 1024 * 1024;

function verifiedDefinition(id: string, text: string): Resource {
  const hit = verifiedBodies.get(id);
  if (hit?.text === text) return hit.resource.clone();
  const body = JSON.parse(text) as Record<string, SchemaValue>;
  if (canonicalSchemaJson(body) !== text)
    throw new Error('Schema body is not canonical JSON');
  const resource = checkDefinition(id, body);
  const bytes = size(id) + size(text);

  while (
    verifiedBodies.size >= CACHE_ENTRIES ||
    cachedBytes + bytes > CACHE_BYTES
  ) {
    const key = verifiedBodies.keys().next().value!;
    cachedBytes -= verifiedBodies.get(key)!.bytes;
    verifiedBodies.delete(key);
  }

  verifiedBodies.set(id, { text, resource: resource.clone(), bytes });
  cachedBytes += bytes;

  return resource;
}

/** No cache mutation or network I/O. Only reachable, verified definitions return. */
export function resolveSchemaDependencies(
  doc: LoroDoc,
  lookup: Lookup,
): Definitions {
  const map = doc.getMap(SCHEMA_ROOT);
  if (map.size > MAX_SCHEMA_DEFINITIONS)
    throw new Error('Too many schema dependencies');
  const attached: Definitions = new Map();
  let bytes = 0;

  for (const [id, text] of map.entries()) {
    if (typeof text !== 'string')
      throw new Error('Schema body must be a canonical JSON string');
    bytes += size(id) + size(text);
    if (bytes > MAX_SCHEMA_BYTES || size(text) > 256 * 1024)
      throw new Error('Schema dependencies exceed byte budget');
    attached.set(id, verifiedDefinition(id, text));
  }

  const queue = links(
    doc.getMap('properties').toJSON() as Record<string, SchemaValue>,
    false,
  ).map(id => ({ id, depth: 0 }));
  const resolved: Definitions = new Map();
  bytes = 0;

  for (let i = 0; i < queue.length; i++) {
    const { id, depth } = queue[i];
    if (resolved.has(id)) continue;
    if (depth > 16 || resolved.size >= MAX_SCHEMA_DEFINITIONS)
      throw new Error('Schema dependency traversal limit exceeded');
    const definition = attached.get(id) ?? lookup(id);
    if (!definition) throw new Error(`Missing frozen schema dependency ${id}`);
    const body = definition.getPropVals() as Record<string, SchemaValue>;
    const checked = attached.has(id) ? definition : checkDefinition(id, body);
    bytes += size(id) + size(canonicalSchemaJson(body));
    if (bytes > MAX_SCHEMA_BYTES)
      throw new Error('Schema dependencies exceed byte budget');
    queue.push(
      ...links(body, true).map(link => ({ id: link, depth: depth + 1 })),
    );
    resolved.set(id, checked);
  }

  return resolved;
}

export function validateSchemaData(
  doc: LoroDoc,
  definitions: Definitions,
): void {
  const values = doc.getMap('properties').toJSON() as Record<
    string,
    SchemaValue
  >;
  const tags = doc.getMap('datatypes');

  for (const [property, value] of Object.entries(values)) {
    if (!isFrozenSchema(property)) continue;
    const definition = definitions.get(identifier(property));
    if (
      !definition ||
      JSON.stringify(definition.get(core.properties.isA)) !==
        JSON.stringify([core.classes.property])
    )
      throw new Error('Expected a Property dependency');
    const shape = definition.get(APP_SHAPE) as AppShape;
    const parsed =
      tags.get(property) === 'json' && typeof value === 'string'
        ? (JSON.parse(value) as SchemaValue)
        : value;
    validateAppValue(shape, parsed);
  }

  const classes = values[core.properties.isA];

  for (const id of classIds(classes)) {
    if (typeof id !== 'string' || !isFrozenSchema(id)) continue;
    const definition = definitions.get(identifier(id));
    if (
      !definition ||
      JSON.stringify(definition.get(core.properties.isA)) !==
        JSON.stringify([core.classes.class])
    )
      throw new Error('Expected a Class dependency');

    for (const required of definition.get(
      core.properties.requires,
    ) as string[]) {
      if (!Object.hasOwn(values, required))
        throw new Error(`Missing required schema field ${required}`);
    }
  }
}

export function attachSchemaDependencies(doc: LoroDoc, lookup: Lookup): void {
  const definitions = resolveSchemaDependencies(doc, lookup);
  if (!definitions.size) return;
  const map = doc.getMap(SCHEMA_ROOT);
  const additions = [...definitions].map(
    ([id, def]) =>
      [id, canonicalSchemaJson(def.getPropVals() as SchemaValue)] as const,
  );
  let bytes = [...map.entries()].reduce(
    (n, [id, body]) => n + size(id) + size(body as string),
    0,
  );
  for (const [id, body] of additions)
    if (map.get(id) === undefined) bytes += size(id) + size(body);
  if (
    bytes > MAX_SCHEMA_BYTES ||
    new Set([...map.keys(), ...definitions.keys()]).size >
      MAX_SCHEMA_DEFINITIONS
  )
    throw new Error('Schema dependencies exceed budget');
  for (const [id, body] of additions)
    if (map.get(id) !== body) map.set(id, body);
}

export function installSchemaDependencies(
  store: Store | undefined,
  definitions: Definitions,
): void {
  if (!store) return;

  for (const [id, definition] of definitions) {
    if (!store.resources.has(id)) store.addResource(definition);
  }
}
