import type { SchemaValue } from './schema-frozen.js';

export type AppShape =
  | { type: 'string'; maxLength?: number }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'nullable'; inner: AppShape }
  | { type: 'union'; variants: readonly AppShape[] }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' | 'null' | 'reference' }
  | {
      type: 'object';
      properties: Record<string, AppShape>;
      required?: readonly string[];
      additionalProperties?: boolean;
    }
  | { type: 'array'; items: AppShape; maxItems: number };

/** Check the supported vocabulary and normalize defaults before hashing. */
export function normalizeAppShape(
  shape: AppShape,
  depth = 0,
  budget = { remaining: 2048 },
): AppShape {
  if (--budget.remaining < 0) throw new Error('Schema exceeds 2048 nodes');
  if (depth > 16 || !shape || typeof shape !== 'object' || Array.isArray(shape))
    throw new Error('Invalid or deeply nested shape');
  const allowed: Record<string, string[]> = {
    string: ['type', 'maxLength'],
    enum: ['type', 'values'],
    nullable: ['type', 'inner'],
    union: ['type', 'variants'],
    number: ['type', 'minimum', 'maximum'],
    integer: ['type', 'minimum', 'maximum'],
    boolean: ['type'],
    null: ['type'],
    reference: ['type'],
    object: ['type', 'properties', 'required', 'additionalProperties'],
    array: ['type', 'items', 'maxItems'],
  };
  if (
    !Object.hasOwn(allowed, shape.type) ||
    Object.keys(shape).some(k => !allowed[shape.type].includes(k))
  )
    throw new Error('Unsupported shape type or keyword');

  switch (shape.type) {
    case 'enum':
      if (
        !Array.isArray(shape.values) ||
        !shape.values.length ||
        shape.values.length > 128 ||
        new Set(shape.values).size !== shape.values.length ||
        shape.values.some(
          v =>
            typeof v !== 'string' || new TextEncoder().encode(v).length > 1024,
        )
      )
        throw new Error('Invalid enum values');

      return { ...shape, values: [...shape.values] };
    case 'nullable':
      return {
        ...shape,
        inner: normalizeAppShape(shape.inner, depth + 1, budget),
      };
    case 'union':
      if (
        !Array.isArray(shape.variants) ||
        shape.variants.length < 2 ||
        shape.variants.length > 8
      )
        throw new Error('Union needs 2-8 variants');

      return {
        ...shape,
        variants: shape.variants.map(s =>
          normalizeAppShape(s, depth + 1, budget),
        ),
      };

    case 'number':
    case 'integer':
      for (const n of [shape.minimum, shape.maximum])
        if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n)))
          throw new Error('Invalid numeric bounds');
      if (
        shape.minimum !== undefined &&
        shape.maximum !== undefined &&
        shape.minimum > shape.maximum
      )
        throw new Error('Invalid numeric bounds');
      break;
    case 'string':
      if (
        shape.maxLength !== undefined &&
        (!Number.isSafeInteger(shape.maxLength) || shape.maxLength < 0)
      )
        throw new Error('Invalid maxLength');
      break;

    case 'object': {
      if (
        !shape.properties ||
        typeof shape.properties !== 'object' ||
        Array.isArray(shape.properties) ||
        Object.keys(shape.properties).length > 128
      )
        throw new Error('Invalid object properties');
      const required = shape.required ?? [];
      if (
        !Array.isArray(required) ||
        required.some(
          k => typeof k !== 'string' || !Object.hasOwn(shape.properties, k),
        )
      )
        throw new Error('Invalid required fields');
      if (
        shape.additionalProperties !== undefined &&
        typeof shape.additionalProperties !== 'boolean'
      )
        throw new Error('Invalid additionalProperties');
      const properties = Object.fromEntries(
        Object.entries(shape.properties).map(([key, value]) => {
          if (!key || new TextEncoder().encode(key).length > 128)
            throw new Error('Invalid field name');

          return [key, normalizeAppShape(value, depth + 1, budget)];
        }),
      );

      return {
        type: 'object',
        properties,
        required,
        additionalProperties: shape.additionalProperties ?? false,
      };
    }

    case 'array':
      if (
        !Number.isSafeInteger(shape.maxItems) ||
        shape.maxItems < 0 ||
        shape.maxItems > 16384
      )
        throw new Error('Invalid maxItems');

      return {
        ...shape,
        items: normalizeAppShape(shape.items, depth + 1, budget),
      };
  }

  return { ...shape };
}

export function validateAppValue(
  shape: AppShape,
  value: SchemaValue,
  path = '$',
): void {
  normalizeAppShape(shape);
  validateValue(shape, value, path, { remaining: 100000 });
}

function validateValue(
  shape: AppShape,
  value: SchemaValue,
  path: string,
  budget: { remaining: number },
): void {
  if (--budget.remaining < 0)
    throw new Error('Validation exceeds 100000 value checks');

  const invalid = () => {
    throw new Error(`Invalid value at ${path}`);
  };

  switch (shape.type) {
    case 'enum':
      if (typeof value !== 'string' || !shape.values.includes(value)) invalid();

      return;
    case 'nullable':
      if (value !== null) validateValue(shape.inner, value, path, budget);

      return;
    case 'union':
      for (const variant of shape.variants) {
        try {
          validateValue(variant, value, path, budget);

          return;
        } catch {
          if (budget.remaining < 0)
            throw new Error('Validation exceeds 100000 value checks');
        }
      }

      throw new Error(`No union variant matches at ${path}`);

    case 'string':
      if (
        typeof value !== 'string' ||
        (shape.maxLength !== undefined &&
          Array.from(value).length > shape.maxLength)
      )
        invalid();

      return;
    case 'number':
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (shape.minimum !== undefined && value < shape.minimum) ||
        (shape.maximum !== undefined && value > shape.maximum) ||
        (shape.type === 'integer' && !Number.isSafeInteger(value))
      )
        invalid();

      return;
    case 'boolean':
      if (typeof value !== 'boolean') invalid();

      return;
    case 'null':
      if (value !== null) invalid();

      return;
    case 'reference':
      if (
        typeof value !== 'string' ||
        !/^(atomic:(?!\/\/)|did:ad:|https?:\/\/)/.test(value as string)
      )
        invalid();
      new URL(value as string);

      return;
    case 'array':
      if (!Array.isArray(value) || value.length > shape.maxItems)
        return invalid();
      value.forEach((v, i) =>
        validateValue(shape.items, v, `${path}/${i}`, budget),
      );

      return;

    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return invalid();
      for (const key of shape.required ?? [])
        if (!Object.hasOwn(value, key))
          throw new Error(`Missing required field at ${path}/${key}`);

      for (const [key, child] of Object.entries(value)) {
        const next = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (Object.hasOwn(shape.properties, key))
          validateValue(shape.properties[key], child, next, budget);
        else if (!shape.additionalProperties)
          throw new Error(`Unknown field at ${next}`);
      }
  }
}
