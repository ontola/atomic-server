import type { JSONValue } from '@tomic/react';
import type { JSONSchema7 } from 'ai';

type Scalar = 'string' | 'number' | 'integer' | 'boolean';

export interface ConfigField {
  key: string;
  def: JSONSchema7;
  type: Scalar;
  required: boolean;
}

export type ConfigObject = Record<string, JSONValue>;

const SCALARS: readonly string[] = ['string', 'number', 'integer', 'boolean'];

export function asConfigObject(config: unknown): ConfigObject {
  return config && typeof config === 'object' && !Array.isArray(config)
    ? (config as ConfigObject)
    : {};
}

/**
 * The fields of a flat object schema, or undefined when the form cannot
 * represent it (nested objects, arrays, unions, no properties). Callers then
 * fall back to the JSON editor, so no schema loses its way to be configured.
 */
export function configFields(schema?: JSONSchema7): ConfigField[] | undefined {
  const entries = Object.entries(schema?.properties ?? {});

  if (!schema || schema.type !== 'object' || entries.length === 0) {
    return undefined;
  }

  const fields: ConfigField[] = [];

  for (const [key, def] of entries) {
    if (typeof def === 'boolean' || def.oneOf || def.anyOf || def.allOf) {
      return undefined;
    }

    if (typeof def.type !== 'string' || !SCALARS.includes(def.type)) {
      return undefined;
    }

    fields.push({
      key,
      def,
      type: def.type as Scalar,
      required: !!schema.required?.includes(key),
    });
  }

  return fields;
}

const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === '';

/** A validation message for one field's current value, or undefined. */
export function fieldError(
  field: ConfigField,
  value: unknown,
): string | undefined {
  const { def, required, type } = field;

  if (isEmpty(value)) return required ? 'This field is required.' : undefined;

  if (def.enum && !def.enum.includes(value as never)) {
    return 'Pick one of the available options.';
  }

  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return 'Enter a number.';
    }

    if (type === 'integer' && !Number.isInteger(value)) {
      return 'Enter a whole number.';
    }

    if (def.minimum !== undefined && value < def.minimum) {
      return `Must be at least ${def.minimum}.`;
    }

    if (def.maximum !== undefined && value > def.maximum) {
      return `Must be at most ${def.maximum}.`;
    }
  }

  if (
    typeof value === 'string' &&
    def.minLength &&
    value.length < def.minLength
  ) {
    return `Must be at least ${def.minLength} characters.`;
  }

  return undefined;
}

export type OnboardingStepId = 'access' | 'config';

/**
 * Steps shown until an installed app is ready to use. The config step exists
 * only when the schema requires something. There is no signal for "first run",
 * so that step is not offered.
 */
export function onboardingSteps(input: {
  active: boolean;
  schema?: JSONSchema7;
  config: unknown;
}): { id: OnboardingStepId; done: boolean }[] {
  const config = asConfigObject(input.config);
  const required = input.schema?.required ?? [];
  const steps: { id: OnboardingStepId; done: boolean }[] = [
    { id: 'access', done: input.active },
  ];

  if (required.length > 0) {
    steps.push({
      id: 'config',
      done: required.every(key => !isEmpty(config[key])),
    });
  }

  return steps;
}
