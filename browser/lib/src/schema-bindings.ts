import {
  appShapeDatatype,
  defineAppSchema,
  type AppSchemaBundle,
} from './app-schema.js';
import type { AppFieldName, TypedAppSchema } from './schema-model.js';
import { normalizeAppShape, type AppShape } from './schema-shape.js';
import {
  APP_SHAPE,
  frozenSchemaId,
  type SchemaValue,
} from './schema-frozen.js';
import { core } from './ontologies/core.js';

export interface PropertyBinding<
  S extends AppShape = AppShape,
  R extends boolean = boolean,
> {
  id: string;
  definition: Record<string, SchemaValue>;
  shape: S;
  required: R;
}
export function bindAppProperty<
  B extends AppSchemaBundle,
  K extends keyof B['fields'] & string,
>(
  bundle: B,
  field: K,
): B extends TypedAppSchema<infer F>
  ? K extends keyof F
    ? PropertyBinding<
        F[K]['shape'],
        F[K] extends { required: true } ? true : false
      >
    : never
  : PropertyBinding {
  const id = bundle.fields[field];
  const definition = bundle.definitions[id];
  if (!definition) throw new Error(`Unknown field ${field}`);

  return {
    id,
    definition,
    shape: definition[APP_SHAPE] as AppShape,
    required: (
      bundle.definitions[bundle.class_id][core.properties.requires] as string[]
    ).includes(id),
  } as ReturnType<typeof bindAppProperty<B, K>>;
}
export function defineAppProperty<
  const S extends AppShape,
  const R extends boolean = false,
>(
  scope: string,
  semanticName: string,
  shape: S,
  required: R = false as R,
): PropertyBinding<S, R> {
  const bundle = defineAppSchema(scope, {
    [semanticName]: { shape, required },
  });

  return { ...bindAppProperty(bundle, semanticName), shape, required };
}
export function composeAppSchema<
  const B extends Record<string, PropertyBinding>,
>(
  name: string,
  description: string,
  bindings: B,
): TypedAppSchema<{
  [K in keyof B]: { shape: B[K]['shape']; required: B[K]['required'] };
}> {
  if (
    !name ||
    new TextEncoder().encode(name).length > 128 ||
    new TextEncoder().encode(description).length > 4096 ||
    Object.keys(bindings).length > 128
  )
    throw new Error('Invalid class bindings');
  const fields: Record<string, string> = Object.create(null);
  const definitions: AppSchemaBundle['definitions'] = Object.create(null);
  const requires: string[] = [],
    recommends: string[] = [];

  // JS code point ordering differs from UTF-8 for non-BMP names.
  const compare = (a: string, b: string) => {
    const x = new TextEncoder().encode(a),
      y = new TextEncoder().encode(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++)
      if (x[i] !== y[i]) return x[i] - y[i];

    return x.length - y.length;
  };

  for (const alias of Object.keys(bindings).sort(compare)) {
    const binding = bindings[alias];
    if (
      !alias ||
      new TextEncoder().encode(alias).length > 128 ||
      Object.hasOwn(definitions, binding.id) ||
      frozenSchemaId(binding.definition) !== binding.id ||
      JSON.stringify(binding.definition[core.properties.isA]) !==
        JSON.stringify([core.classes.property])
    )
      throw new Error('Invalid or duplicate property binding');
    const shape = normalizeAppShape(binding.definition[APP_SHAPE] as AppShape);
    if (
      typeof binding.required !== 'boolean' ||
      binding.definition[core.properties.datatype] !==
        appShapeDatatype(shape) ||
      frozenSchemaId({ shape } as SchemaValue) !==
        frozenSchemaId({
          shape: normalizeAppShape(binding.shape),
        } as SchemaValue)
    )
      throw new Error('Property binding shape/datatype mismatch');
    fields[alias] = binding.id;
    definitions[binding.id] = binding.definition;
    (binding.required ? requires : recommends).push(binding.id);
  }

  for (const members of [requires, recommends]) {
    members.sort(
      (a, b) =>
        compare(
          definitions[a][core.properties.shortname] as string,
          definitions[b][core.properties.shortname] as string,
        ) || compare(a, b),
    );
  }

  const body = {
    [core.properties.isA]: [core.classes.class],
    [core.properties.shortname]: name,
    [core.properties.description]: description,
    [core.properties.requires]: requires,
    [core.properties.recommends]: recommends,
  };
  const class_id = frozenSchemaId(body);
  definitions[class_id] = body;

  return { class_id, fields, definitions } as TypedAppSchema<{
    [K in keyof B]: { shape: B[K]['shape']; required: B[K]['required'] };
  }>;
}

type Rebound<B, Old extends string, New extends string> =
  B extends TypedAppSchema<infer F>
    ? TypedAppSchema<{ [K in keyof F as K extends Old ? New : K]: F[K] }>
    : AppSchemaBundle;

export function rebindAppField<
  B extends AppSchemaBundle,
  Old extends AppFieldName<B>,
  const New extends string,
>(bundle: B, old: Old, alias: New): Rebound<B, Old, New> {
  if (
    !Object.hasOwn(bundle.fields, old) ||
    !alias ||
    new TextEncoder().encode(alias).length > 128 ||
    ((old as string) !== alias && Object.hasOwn(bundle.fields, alias))
  )
    throw new Error('Invalid alias');
  const fields = { ...bundle.fields };
  const id = fields[old];
  delete fields[old];
  Object.defineProperty(fields, alias, {
    value: id,
    enumerable: true,
    writable: true,
    configurable: true,
  });

  return { ...bundle, fields } as unknown as Rebound<B, Old, New>;
}
