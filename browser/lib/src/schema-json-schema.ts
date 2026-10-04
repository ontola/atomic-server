/** Bounded JSON Schema 2020-12 interchange; no fetching or executable hooks. */
import {
  defineAppSchema,
  checkAppSchema,
  type AppSchemaBundle,
  type AppField,
} from './app-schema.js';
import { normalizeAppShape, type AppShape } from './schema-shape.js';
import {
  APP_SHAPE,
  canonicalSchemaJson,
  type SchemaValue,
} from './schema-frozen.js';
import { core } from './ontologies/core.js';

export const JSON_SCHEMA_DIALECT =
  'https://json-schema.org/draft/2020-12/schema';
export const ATOMIC_LINK_PATTERN = '^(atomic:(?!//)|did:ad:|https?://)';
const SAFE = Number.MAX_SAFE_INTEGER;
type Obj = Record<string, SchemaValue>;

function error(path: string, message: string): never {
  throw new Error(`JSON Schema at ${path || '/'}: ${message}`);
}

function child(path: string, key: string): string {
  return `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function object(value: unknown, path: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    error(path, 'expected a schema object; boolean schemas are unsupported');

  return value as Obj;
}

function bounded(value: unknown): asserts value is SchemaValue {
  let remaining = 32768;
  let bytes = 1024 * 1024;

  const visit = (v: unknown, depth: number): void => {
    if (--remaining < 0 || depth > 64)
      error('', 'document exceeds depth/node budget');

    if (typeof v === 'string') {
      bytes -= v.length;
      if (bytes < 0) error('', 'document exceeds 1 MiB');

      return;
    }

    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;

    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);

      return;
    }

    if (
      v &&
      typeof v === 'object' &&
      [null, Object.prototype].includes(Object.getPrototypeOf(v))
    ) {
      for (const [key, item] of Object.entries(v)) {
        bytes -= key.length;
        if (bytes < 0) error('', 'document exceeds 1 MiB');
        visit(item, depth + 1);
      }

      return;
    }

    error('', 'expected JSON data');
  };

  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024)
    error('', 'document exceeds 1 MiB');
}

/** Plain JSON Schema to the bounded internal shape. Unsupported constraints fail. */
export function shapeFromJsonSchema(input: unknown): AppShape {
  bounded(input);
  const root = object(input, '');
  let remaining = 2048;
  const refs: string[] = [];

  const read = (value: SchemaValue, path: string, depth: number): AppShape => {
    if (--remaining < 0 || depth > 16)
      error(path, 'expanded schema exceeds depth/node budget');
    const m = object(value, path);

    for (const [key, v] of Object.entries(m)) {
      if (
        ![
          '$schema',
          '$id',
          '$defs',
          'title',
          'description',
          '$comment',
          'default',
          'examples',
          '$ref',
          'anyOf',
          'type',
          'enum',
          'const',
          'properties',
          'required',
          'additionalProperties',
          'items',
          'maxItems',
          'maxLength',
          'minimum',
          'maximum',
          'format',
          'pattern',
          'x-atomic-link',
        ].includes(key)
      )
        error(child(path, key), 'unsupported keyword');
      if (
        ['title', 'description', '$comment'].includes(key) &&
        typeof v !== 'string'
      )
        error(child(path, key), 'expected annotation string');
      if (key === 'examples' && !Array.isArray(v))
        error(child(path, key), 'expected examples array');
      if (key === '$schema' && (path !== '' || v !== JSON_SCHEMA_DIALECT))
        error(child(path, key), 'only root JSON Schema 2020-12 is supported');

      if (key === '$id') {
        if (path !== '' || typeof v !== 'string')
          error(child(path, key), 'only an absolute root $id is supported');

        try {
          new URL(v);
        } catch {
          error(child(path, key), 'only an absolute root $id is supported');
        }
      }

      if (
        key === '$defs' &&
        (path !== '' || !v || typeof v !== 'object' || Array.isArray(v))
      )
        error(child(path, key), 'only root $defs are supported');
    }

    const allowed = (extra: string[]): void => {
      for (const key of Object.keys(m))
        if (
          ![
            '$schema',
            '$id',
            '$defs',
            'title',
            'description',
            '$comment',
            'default',
            'examples',
            ...extra,
          ].includes(key)
        )
          error(child(path, key), 'unsupported keyword or keyword combination');
    };

    if (Object.hasOwn(m, '$ref')) {
      allowed(['$ref']);
      const ref = m.$ref;
      if (typeof ref !== 'string') error(path, '$ref must be a string');
      if (!/^#\/\$defs\/[^/%]+$/.test(ref))
        error(path, 'only local #/$defs/name references are supported');
      const token = ref.slice('#/$defs/'.length);
      if (/~(?![01])/.test(token)) error(path, 'invalid JSON Pointer escape');
      const name = token.replaceAll('~1', '/').replaceAll('~0', '~');
      if (refs.includes(ref))
        error(path, 'recursive references are unsupported');
      const defs = root.$defs as Obj | undefined;
      if (!defs || !Object.hasOwn(defs, name))
        error(path, 'unresolved local reference');
      refs.push(ref);
      const result = read(defs[name], `/$defs/${token}`, depth + 1);
      refs.pop();

      return result;
    }

    if (Object.hasOwn(m, 'anyOf')) {
      allowed(['anyOf']);
      const variants = m.anyOf;
      if (
        !Array.isArray(variants) ||
        variants.length < 2 ||
        variants.length > 8
      )
        error(path, 'anyOf needs 2-8 alternatives');

      return normalizeAppShape({
        type: 'union',
        variants: variants.map((v, i) =>
          read(v, `${path}/anyOf/${i}`, depth + 1),
        ),
      });
    }

    if (Array.isArray(m.type)) {
      if (Object.hasOwn(m, 'enum') || Object.hasOwn(m, 'const'))
        error(path, 'type arrays combined with enum/const are unsupported');
      const types = m.type;
      if (types.length !== 2 || types.filter(v => v === 'null').length !== 1)
        error(
          path,
          'type arrays must contain one type and null; use anyOf for other unions',
        );
      const base = types.find(v => v !== 'null');
      if (typeof base !== 'string') error(path, 'type must be a string');
      const inner: Obj = { ...m, type: base };
      delete inner.$schema;
      delete inner.$id;
      delete inner.$defs;

      return {
        type: 'nullable',
        inner: read(inner, child(path, 'type'), depth + 1),
      };
    }

    if (Object.hasOwn(m, 'enum') || Object.hasOwn(m, 'const')) {
      allowed(['type', 'enum', 'const']);
      if (
        (Object.hasOwn(m, 'enum') && Object.hasOwn(m, 'const')) ||
        (Object.hasOwn(m, 'type') && m.type !== 'string')
      )
        error(path, 'only string enum or string const is supported');
      const values = Object.hasOwn(m, 'enum') ? m.enum : [m.const];
      if (!Array.isArray(values)) error(path, 'enum must be an array');
      if (values.some(v => typeof v !== 'string'))
        error(path, 'only string enum values are supported');

      return normalizeAppShape({ type: 'enum', values: values as string[] });
    }

    let shape: AppShape;

    switch (m.type) {
      case 'object': {
        allowed(['type', 'properties', 'required', 'additionalProperties']);
        const props = Object.hasOwn(m, 'properties')
          ? object(m.properties, child(path, 'properties'))
          : {};
        const required = Object.hasOwn(m, 'required') ? m.required : [];
        if (
          !Array.isArray(required) ||
          required.some(v => typeof v !== 'string')
        )
          error(path, 'required names must be strings');
        if (new Set(required).size !== required.length)
          error(path, 'required names must be unique');
        const additional = Object.hasOwn(m, 'additionalProperties')
          ? m.additionalProperties
          : true;
        if (typeof additional !== 'boolean')
          error(path, 'schema-valued additionalProperties is unsupported');
        shape = {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(props).map(([k, v]) => [
              k,
              read(v, child(child(path, 'properties'), k), depth + 1),
            ]),
          ),
          required: required as string[],
          additionalProperties: additional,
        };
        break;
      }

      case 'array': {
        allowed(['type', 'items', 'maxItems']);
        if (!Object.hasOwn(m, 'items')) error(path, 'items is required');
        if (
          typeof m.maxItems !== 'number' ||
          !Number.isSafeInteger(m.maxItems) ||
          m.maxItems < 0 ||
          m.maxItems > 16384
        )
          error(
            child(path, 'maxItems'),
            'an explicit integer maxItems between 0 and 16384 is required',
          );
        shape = {
          type: 'array',
          items: read(m.items, child(path, 'items'), depth + 1),
          maxItems: m.maxItems,
        };
        break;
      }

      case 'string': {
        if (m['x-atomic-link'] === true) {
          allowed(['type', 'format', 'pattern', 'x-atomic-link']);
          if (m.format !== 'uri' || m.pattern !== ATOMIC_LINK_PATTERN)
            error(
              path,
              'Atomic links require format uri and the Atomic URI pattern',
            );
          shape = { type: 'reference' };
        } else {
          allowed(['type', 'maxLength']);
          if (
            Object.hasOwn(m, 'maxLength') &&
            (typeof m.maxLength !== 'number' ||
              !Number.isSafeInteger(m.maxLength) ||
              m.maxLength < 0)
          )
            error(path, 'maxLength must be a nonnegative safe integer');
          shape = {
            type: 'string',
            ...(Object.hasOwn(m, 'maxLength')
              ? { maxLength: m.maxLength as number }
              : {}),
          };
        }

        break;
      }

      case 'integer':

      case 'number': {
        allowed(['type', 'minimum', 'maximum']);
        for (const key of ['minimum', 'maximum'])
          if (
            Object.hasOwn(m, key) &&
            (typeof m[key] !== 'number' || !Number.isFinite(m[key]))
          )
            error(child(path, key), 'expected finite number');
        const minimum = m.minimum as number | undefined,
          maximum = m.maximum as number | undefined;
        if (
          m.type === 'integer' &&
          (minimum === undefined ||
            maximum === undefined ||
            minimum < -SAFE ||
            maximum > SAFE)
        )
          error(
            path,
            "integer requires explicit minimum/maximum within JavaScript's safe range",
          );
        shape = {
          type: m.type,
          ...(minimum === undefined ? {} : { minimum }),
          ...(maximum === undefined ? {} : { maximum }),
        };
        break;
      }

      case 'boolean':
      case 'null':
        allowed(['type']);
        shape = { type: m.type };
        break;
      default:
        error(child(path, 'type'), 'explicit supported type is required');
    }

    try {
      return normalizeAppShape(shape);
    } catch (e) {
      error(path, String(e));
    }
  };

  const result = read(root, '', 0);
  if (root.$defs)
    for (const [name, v] of Object.entries(root.$defs as Obj))
      read(v, child('/$defs', name), 1);

  return normalizeAppShape(result);
}
export function shapeToJsonSchema(input: AppShape): Obj {
  const shape = normalizeAppShape(input);

  switch (shape.type) {
    case 'enum':
      return { type: 'string', enum: [...shape.values] };
    case 'nullable':
      return { anyOf: [shapeToJsonSchema(shape.inner), { type: 'null' }] };
    case 'union':
      return { anyOf: shape.variants.map(shapeToJsonSchema) };
    case 'reference':
      return {
        type: 'string',
        format: 'uri',
        pattern: ATOMIC_LINK_PATTERN,
        'x-atomic-link': true,
      };
    case 'integer':
      return {
        type: 'integer',
        minimum: Math.max(shape.minimum ?? -SAFE, -SAFE),
        maximum: Math.min(shape.maximum ?? SAFE, SAFE),
      };
    case 'array':
      return {
        type: 'array',
        items: shapeToJsonSchema(shape.items),
        maxItems: shape.maxItems,
      };
    case 'object':
      return {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(shape.properties).map(([k, v]) => [
            k,
            shapeToJsonSchema(v),
          ]),
        ),
        required: [...(shape.required ?? [])],
        additionalProperties: shape.additionalProperties ?? false,
      };
    default:
      return { ...shape };
  }
}
export function appSchemaFromJsonSchema(
  name: string,
  input: unknown,
): AppSchemaBundle {
  const shape = shapeFromJsonSchema(input);
  if (shape.type !== 'object') error('', 'app schema root must be an object');
  if (shape.additionalProperties)
    error(
      '/additionalProperties',
      'app roots require explicit false; open nested objects are supported',
    );
  const fields: Record<string, AppField> = Object.fromEntries(
    Object.entries(shape.properties).map(([key, value]) => [
      key,
      { shape: value, required: shape.required?.includes(key) ?? false },
    ]),
  );

  return defineAppSchema(name, fields);
}
export function appSchemaToJsonSchema(bundle: AppSchemaBundle): Obj {
  checkAppSchema(bundle);
  const required = bundle.definitions[bundle.class_id][
    core.properties.requires
  ] as string[];
  const schema: Obj = {
    $schema: JSON_SCHEMA_DIALECT,
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(bundle.fields).map(([alias, id]) => [
        alias,
        shapeToJsonSchema(bundle.definitions[id][APP_SHAPE] as AppShape),
      ]),
    ),
    required: Object.entries(bundle.fields)
      .filter(([, id]) => required.includes(id))
      .map(([alias]) => alias)
      .sort((a, b) => {
        const x = new TextEncoder().encode(a),
          y = new TextEncoder().encode(b);
        for (let i = 0; i < Math.min(x.length, y.length); i++)
          if (x[i] !== y[i]) return x[i] - y[i];

        return x.length - y.length;
      }),
    additionalProperties: false,
  };
  bounded(schema);

  return schema;
}
export interface JsonSchemaDocument {
  schema: Obj;
  atomic: AppSchemaBundle;
}
export function exportJsonSchema(bundle: AppSchemaBundle): JsonSchemaDocument {
  const document = {
    schema: appSchemaToJsonSchema(bundle),
    atomic: structuredClone(bundle),
  };
  bounded(document);

  return document;
}
export function importJsonSchema(
  document: JsonSchemaDocument,
): AppSchemaBundle {
  bounded(document);
  if (Object.keys(document).some(k => !['schema', 'atomic'].includes(k)))
    error('', 'unknown document member');
  checkAppSchema(document.atomic);
  const expected = shapeToJsonSchema(
    shapeFromJsonSchema(appSchemaToJsonSchema(document.atomic)),
  );
  const actual = shapeToJsonSchema(shapeFromJsonSchema(document.schema));
  if (
    canonicalSchemaJson(normalizedConstraints(expected)) !==
    canonicalSchemaJson(normalizedConstraints(actual))
  )
    error(
      '',
      'schema constraints do not match the immutable Atomic bindings; define a new schema version',
    );

  return structuredClone(document.atomic);
}

function normalizedConstraints(value: SchemaValue): SchemaValue {
  if (Array.isArray(value)) return value.map(normalizedConstraints);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        const result = normalizedConstraints(v);
        if (
          ['required', 'enum', 'anyOf'].includes(key) &&
          Array.isArray(result)
        )
          result.sort((a, b) =>
            canonicalSchemaJson(a) < canonicalSchemaJson(b)
              ? -1
              : canonicalSchemaJson(a) > canonicalSchemaJson(b)
                ? 1
                : 0,
          );

        return [key, result];
      }),
    );

  return value;
}
