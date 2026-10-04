import { core } from './ontologies/core.js';
import { Datatype } from './datatypes.js';
import { Resource } from './resource.js';
import { enableLoro } from './loro-loader.js';
import type { Store } from './store.js';
import { JSONADParser } from './parse.js';
import type { JSONValue } from './value.js';
import {
  APP_SCOPE,
  APP_SHAPE,
  frozenSchemaId,
  canonicalSchemaJson,
  type SchemaValue,
  verifyFrozenSchema,
} from './schema-frozen.js';
import {
  normalizeAppShape,
  validateAppValue,
  type AppShape,
} from './schema-shape.js';

export {
  type AppShape,
  normalizeAppShape,
  validateAppValue,
} from './schema-shape.js';
export {
  frozenSchemaId,
  canonicalSchemaJson,
  type SchemaValue,
} from './schema-frozen.js';
export interface AppField {
  shape: AppShape;
  required?: boolean;
}
export interface AppSchemaBundle {
  class_id: string;
  fields: Record<string, string>;
  definitions: Record<string, Record<string, SchemaValue>>;
}

export function appShapeDatatype(shape: AppShape): Datatype {
  switch (shape.type) {
    case 'string':
      return Datatype.STRING;
    case 'number':
      return Datatype.FLOAT;
    case 'integer':
      return Datatype.INTEGER;
    case 'boolean':
      return Datatype.BOOLEAN;
    case 'reference':
      return Datatype.ATOMIC_URL;
    default:
      return Datatype.JSON;
  }
}

/** Define a versioned app vocabulary without choosing a hosting domain. */
export function defineAppSchema(
  name: string,
  fields: Record<string, AppField>,
): AppSchemaBundle {
  if (
    !name ||
    new TextEncoder().encode(name).length > 128 ||
    Object.keys(fields).length > 128
  )
    throw new Error('Invalid schema name or field count');
  const definitions: AppSchemaBundle['definitions'] = Object.create(null);
  const bindings: Record<string, string> = Object.create(null);
  const requires: string[] = [],
    recommends: string[] = [];
  // Rust BTreeMap uses UTF-8 scalar order; field ordering in required/recommended
  // arrays is explicit and therefore part of the bundle identity.
  const keys = Object.keys(fields).sort((a, b) => {
    const x = new TextEncoder().encode(a),
      y = new TextEncoder().encode(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++)
      if (x[i] !== y[i]) return x[i] - y[i];

    return x.length - y.length;
  });

  for (const key of keys) {
    if (!key || new TextEncoder().encode(key).length > 128)
      throw new Error('Invalid field name');
    const field = fields[key];
    if (
      Object.keys(field).some(k => !['shape', 'required'].includes(k)) ||
      (field.required !== undefined && typeof field.required !== 'boolean')
    )
      throw new Error('Invalid field definition');
    const shape = normalizeAppShape(field.shape);
    const body: Record<string, SchemaValue> = {
      [core.properties.isA]: [core.classes.property],
      [core.properties.shortname]: key,
      [core.properties.description]: '',
      [core.properties.datatype]: appShapeDatatype(shape),
      [APP_SCOPE]: name,
      [APP_SHAPE]: shape as SchemaValue,
    };
    const id = frozenSchemaId(body);
    definitions[id] = body;
    bindings[key] = id;
    (field.required ? requires : recommends).push(id);
  }

  const body = {
    [core.properties.isA]: [core.classes.class],
    [core.properties.shortname]: name,
    [core.properties.description]: '',
    [core.properties.requires]: requires,
    [core.properties.recommends]: recommends,
  };
  const class_id = frozenSchemaId(body);
  definitions[class_id] = body;

  return { class_id, fields: bindings, definitions };
}

/** Validate all definitions before installing any. Call on every app startup. */
export function registerAppSchema(store: Store, bundle: AppSchemaBundle): void {
  const entries = Object.entries(bundle.definitions);
  if (
    entries.length !== Object.keys(bundle.fields).length + 1 ||
    Object.keys(bundle.fields).length > 128
  )
    throw new Error('Schema bundle too large');
  const allowed = new Set<string>([
    core.properties.isA,
    core.properties.requires,
    core.properties.recommends,
    core.properties.datatype,
    core.properties.shortname,
    core.properties.description,
    APP_SCOPE,
    APP_SHAPE,
  ]);
  const resources = entries.map(([id, body]) => {
    if (
      id !== frozenSchemaId(body) ||
      Object.keys(body).some(k => !allowed.has(k))
    )
      throw new Error('Invalid schema definition');

    if (body[APP_SHAPE]) {
      const normalized = normalizeAppShape(body[APP_SHAPE] as AppShape);
      if (
        canonicalSchemaJson(body[APP_SHAPE]) !==
        canonicalSchemaJson(normalized as SchemaValue)
      )
        throw new Error('Shape must use normalized defaults');
    }

    for (const key of [
      core.properties.shortname,
      core.properties.description,
      APP_SCOPE,
    ]) {
      if (Object.hasOwn(body, key) && typeof body[key] !== 'string')
        throw new Error('Expected schema text');
    }

    const [resource] = new JSONADParser().parse({ '@id': id, ...body });
    if (resource.error) throw resource.error;
    verifyFrozenSchema(resource);

    return resource;
  });
  const cls = bundle.definitions[bundle.class_id];
  if (
    !cls ||
    JSON.stringify(cls[core.properties.isA]) !==
      JSON.stringify([core.classes.class])
  )
    throw new Error('Missing class');
  const requires = cls[core.properties.requires],
    recommends = cls[core.properties.recommends];
  if (!Array.isArray(requires) || !Array.isArray(recommends))
    throw new Error('Invalid class bindings');
  const ids = [...requires, ...recommends];
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== Object.keys(bundle.fields).length
  )
    throw new Error('Incomplete class bindings');

  for (const [key, id] of Object.entries(bundle.fields)) {
    const def = bundle.definitions[id];
    if (
      !def ||
      JSON.stringify(def[core.properties.isA]) !==
        JSON.stringify([core.classes.property]) ||
      def[core.properties.shortname] !== key ||
      !ids.includes(id) ||
      def[core.properties.datatype] !==
        appShapeDatatype(normalizeAppShape(def[APP_SHAPE] as AppShape))
    )
      throw new Error('Invalid field binding');
  }

  for (const resource of resources) store.addResource(resource);
}

export async function setAppField(
  resource: Resource,
  bundle: AppSchemaBundle,
  field: string,
  value: SchemaValue,
): Promise<void> {
  const id = bundle.fields[field];
  const shape = bundle.definitions[id]?.[APP_SHAPE] as AppShape;
  if (!id || !shape) throw new Error(`Unknown field ${field}`);
  validateAppValue(shape, value);
  await enableLoro();
  await resource.set(id, value as JSONValue, true, appShapeDatatype(shape));
}

export async function patchAppField(
  resource: Resource,
  bundle: AppSchemaBundle,
  field: string,
  path: string[],
  value: SchemaValue | undefined,
): Promise<void> {
  const id = bundle.fields[field];
  if (!id) throw new Error(`Unknown field ${field}`);
  await resource.patchJsonPath(id, path, value as JSONValue | undefined);
}
