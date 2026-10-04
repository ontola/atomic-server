import type { SchemaValue } from './schema-frozen.js';

export type AppShape =
  | { type: 'string'; maxLength?: number }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' | 'null' | 'reference' }
  | {
      type: 'object';
      properties: Record<string, AppShape>;
      required?: string[];
      additionalProperties?: boolean;
    }
  | { type: 'array'; items: AppShape; maxItems: number };

/** Check the supported vocabulary and normalize defaults before hashing. */
export function normalizeAppShape(shape: AppShape, depth = 0): AppShape {
  if (depth > 16 || !shape || typeof shape !== 'object' || Array.isArray(shape))
    throw new Error('Invalid or deeply nested shape');
  const allowed: Record<string, string[]> = {
    string: ['type', 'maxLength'],
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

          return [key, normalizeAppShape(value, depth + 1)];
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

      return { ...shape, items: normalizeAppShape(shape.items, depth + 1) };
  }

  return { ...shape };
}

export function validateAppValue(
  shape: AppShape,
  value: SchemaValue,
  path = '$',
): void {
  normalizeAppShape(shape);

  const invalid = () => {
    throw new Error(`Invalid value at ${path}`);
  };

  switch (shape.type) {
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
      value.forEach((v, i) => validateAppValue(shape.items, v, `${path}/${i}`));

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
          validateAppValue(shape.properties[key], child, next);
        else if (!shape.additionalProperties)
          throw new Error(`Unknown field at ${next}`);
      }
  }
}
