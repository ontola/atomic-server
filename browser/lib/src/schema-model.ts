import type { AppField, AppSchemaBundle } from './app-schema.js';
import { validateAppValue, type AppShape } from './schema-shape.js';
import { APP_SHAPE } from './schema-frozen.js';
import type { SchemaValue } from './schema-frozen.js';
import type { Resource } from './resource.js';
import { core } from './ontologies/core.js';

export type InferShape<S> = S extends {
  type: 'enum';
  values: readonly (infer V)[];
}
  ? V
  : S extends { type: 'nullable'; inner: infer I }
    ? InferShape<I> | null
    : S extends { type: 'union'; variants: readonly (infer V)[] }
      ? InferShape<V>
      : S extends { type: 'string' | 'reference' }
        ? string
        : S extends { type: 'number' | 'integer' }
          ? number
          : S extends { type: 'boolean' }
            ? boolean
            : S extends { type: 'null' }
              ? null
              : S extends { type: 'array'; items: infer I }
                ? InferShape<I>[]
                : S extends {
                      type: 'object';
                      properties: infer P;
                      required?: readonly string[];
                    }
                  ? {
                      [K in keyof P as K extends (
                        S extends { required: readonly (infer R)[] } ? R : never
                      )
                        ? K
                        : never]: InferShape<P[K]>;
                    } & {
                      [K in keyof P as K extends (
                        S extends { required: readonly (infer R)[] } ? R : never
                      )
                        ? never
                        : K]?: InferShape<P[K]>;
                    } & (S extends { additionalProperties: true }
                        ? Record<string, SchemaValue>
                        : {})
                  : SchemaValue;
/** Compile-time metadata only: never serialized into a portable bundle. */
export type TypedAppSchema<F extends Record<string, AppField>> =
  AppSchemaBundle & { readonly __fields: F };
export type AppFieldName<B> = B extends { readonly __fields: infer F }
  ? keyof F & string
  : string;
export type AppFieldValue<B, K> = B extends { readonly __fields: infer F }
  ? K extends keyof F
    ? F[K] extends { shape: infer S }
      ? InferShape<S>
      : never
    : never
  : SchemaValue;
export type AppModel<B> = B extends { readonly __fields: infer F }
  ? {
      [K in keyof F as F[K] extends { required: true }
        ? K
        : never]: F[K] extends { shape: infer S } ? InferShape<S> : never;
    } & {
      [K in keyof F as F[K] extends { required: true }
        ? never
        : K]?: F[K] extends { shape: infer S } ? InferShape<S> : never;
    }
  : Record<string, SchemaValue>;

export function readAppModel<B extends AppSchemaBundle>(
  resource: Resource,
  bundle: B,
): AppModel<B> {
  const data: Record<string, SchemaValue> = Object.create(null);
  const required = bundle.definitions[bundle.class_id][
    core.properties.requires
  ] as string[];

  for (const [alias, id] of Object.entries(bundle.fields)) {
    const value = resource.get(id) as SchemaValue | undefined;

    if (value === undefined) {
      if (required.includes(id))
        throw new Error(`Missing required field ${alias}`);
      continue;
    }

    validateAppValue(bundle.definitions[id][APP_SHAPE] as AppShape, value);
    data[alias] = value;
  }

  return data as AppModel<B>;
}
